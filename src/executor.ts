import { EventType, chat } from '@tanstack/ai'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { defineSandbox, defineWorkspace, withSandbox } from '@tanstack/ai-sandbox'
import { localProcessSandbox } from '@tanstack/ai-sandbox-local-process'
import { buildAdapter, sessionEventName } from './harnesses.js'
import { preflightAgents } from './preflight.js'
import { sshProcessSandbox } from './sandbox/ssh.js'
import { assertCommandSuccess, executeTarget } from './target-command.js'
import { HARNESS_NAMES, REASONING_LEVELS } from './types.js'
import { createManagedWorkspace } from './workspaces.js'
import type { StreamChunk } from '@tanstack/ai'
import type { RunStore } from './store.js'
import type {
  AgentResult,
  AgentRunOptions,
  AgentSession,
  ManagedWorkspace,
  ResolvedLocation,
  Target,
  TranscriptEntry,
  WorkflowContext,
} from './types.js'

const SUBSCRIPTION_API_KEYS = ['ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'OPENAI_API_KEY']

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function cleanupProjectionMarkers(cwd: string, target: Target): Promise<void> {
  if (target.kind === 'ssh') {
    const result = await executeTarget(
      'sh',
      [
        '-c',
        'for path in .tanstack-projected-*; do [ ! -e "$path" ] || rm -f -- "$path"; done',
      ],
      cwd,
      target,
    )
    assertCommandSuccess(
      result,
      `Cannot clean projection markers in ${target.host}:${cwd}`,
    )
    return
  }
  const entries = await readdir(cwd)
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith('.tanstack-projected-'))
      .map((entry) => unlink(join(cwd, entry))),
  )
}

function resolvedLocation(target: Target, cwd: string): ResolvedLocation {
  return target.kind === 'local' ? { target, cwd } : { target, cwd }
}

function sameTarget(left: Target, right: Target): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'local' || right.kind === 'local') return true
  if (left.host !== right.host) return false
  return JSON.stringify(left.sshArgs ?? []) === JSON.stringify(right.sshArgs ?? [])
}

function sameLocation(left: ResolvedLocation, right: ResolvedLocation): boolean {
  return left.cwd === right.cwd && sameTarget(left.target, right.target)
}

function sessionIdFrom(chunk: StreamChunk, eventName: string): string | undefined {
  if (chunk.type !== EventType.CUSTOM || chunk.name !== eventName) return undefined
  if (chunk.value === null || typeof chunk.value !== 'object') return undefined
  if (!('sessionId' in chunk.value)) return undefined
  const sessionId = (chunk.value as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' ? sessionId : undefined
}

function validate(options: AgentRunOptions): void {
  if (!options.id.trim()) throw new Error('Agent run id is required')
  if (!options.model.trim())
    throw new Error(`Agent ${options.id} needs an exact model ID`)
  if (!options.prompt.trim()) throw new Error(`Agent ${options.id} needs a prompt`)
  if (!HARNESS_NAMES.includes(options.harness)) {
    throw new Error(`Agent ${options.id} has unsupported harness ${options.harness}`)
  }
  if (
    options.reasoning !== undefined &&
    !REASONING_LEVELS.includes(options.reasoning)
  ) {
    throw new Error(`Agent ${options.id} has unsupported reasoning level`)
  }
  if (
    options.location?.target?.kind === 'ssh' &&
    !options.location.target.host.trim()
  ) {
    throw new Error(`Agent ${options.id} has an empty SSH host`)
  }
  if (
    options.location?.worktreeRevision !== undefined &&
    options.location.worktree !== true
  ) {
    throw new Error(`Agent ${options.id} sets worktreeRevision without worktree: true`)
  }
  if (options.location?.target?.kind === 'ssh' && options.location.cwd === undefined) {
    throw new Error(`Agent ${options.id} needs an explicit cwd for an SSH location`)
  }
  if (options.resume !== undefined && options.resume.harness !== options.harness) {
    throw new Error(
      `Agent ${options.id} cannot resume a ${options.resume.harness} session with ${options.harness}`,
    )
  }
  if (options.resume !== undefined && options.location?.worktree === true) {
    throw new Error(
      `Agent ${options.id} cannot resume into a new managed workspace; omit location or use the session location`,
    )
  }
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value)
}

function transcriptFromChunk(
  agentId: string,
  chunk: StreamChunk,
): Omit<TranscriptEntry, 'seq' | 'at' | 'runId'> | null {
  const data = chunk as unknown as Record<string, unknown>
  const messageId =
    typeof data.messageId === 'string'
      ? data.messageId
      : typeof data.toolCallId === 'string'
        ? data.toolCallId
        : undefined
  const identified = messageId === undefined ? {} : { messageId }
  switch (chunk.type) {
    case EventType.TEXT_MESSAGE_CONTENT:
      return { agentId, kind: 'assistant', content: chunk.delta, ...identified }
    case EventType.REASONING_MESSAGE_CONTENT:
      return {
        agentId,
        kind: 'reasoning',
        content: stringValue(data.delta ?? data.content),
        ...identified,
      }
    case EventType.TOOL_CALL_START:
      return {
        agentId,
        kind: 'tool',
        content: stringValue(data.toolCallName ?? data.toolName),
        ...identified,
        data: chunk,
      }
    case EventType.TOOL_CALL_ARGS:
      return {
        agentId,
        kind: 'tool',
        content: stringValue(data.delta ?? data.args),
        ...identified,
        data: chunk,
      }
    case EventType.TOOL_CALL_RESULT:
      return {
        agentId,
        kind: 'tool-result',
        content: stringValue(data.content ?? data.result),
        ...identified,
        data: chunk,
      }
    case EventType.RUN_ERROR:
      return {
        agentId,
        kind: 'error',
        content: chunk.message,
        ...identified,
        data: chunk,
      }
    default:
      return null
  }
}

export class WorkflowExecutor {
  private readonly agentIds = new Set<string>()
  private readonly abortController = new AbortController()

  constructor(
    private readonly runId: string,
    private readonly runName: string,
    private readonly workflowCwd: string,
    private readonly args: Array<string>,
    private readonly store: RunStore,
  ) {}

  context(): WorkflowContext {
    return {
      args: [...this.args],
      run: (options) => this.runAgent(options),
      preflight: (options) => {
        const ids = new Set<string>()
        for (const option of options) {
          validate(option)
          if (ids.has(option.id)) {
            throw new Error(
              `Agent run id ${JSON.stringify(option.id)} appears more than once in preflight`,
            )
          }
          ids.add(option.id)
        }
        return preflightAgents(options, this.workflowCwd)
      },
      parallel: async (operations) => {
        const settled = await Promise.allSettled(operations)
        const failures = settled.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        )
        if (failures.length > 0) {
          throw new AggregateError(
            failures.map((failure) => failure.reason),
            `${failures.length} parallel operation${failures.length === 1 ? '' : 's'} failed`,
          )
        }
        return settled.map((result) =>
          result.status === 'fulfilled' ? result.value : undefined,
        ) as never
      },
      settle: (operations) => Promise.allSettled(operations) as never,
    }
  }

  abort(): void {
    this.abortController.abort()
  }

  private async runAgent(options: AgentRunOptions): Promise<AgentResult> {
    validate(options)
    if (this.agentIds.has(options.id)) {
      throw new Error(`Agent run id ${JSON.stringify(options.id)} is already in use`)
    }
    this.agentIds.add(options.id)

    const selectedLocation = options.location ?? options.resume?.location
    const target = selectedLocation?.target ?? { kind: 'local' }
    const sourceCwd = selectedLocation?.cwd ?? this.workflowCwd
    const now = new Date().toISOString()
    await this.store.update(this.runId, (record) => {
      record.agents[options.id] = {
        id: options.id,
        model: options.model,
        harness: options.harness,
        target,
        cwd: sourceCwd,
        status: 'queued',
        startedAt: now,
        textChars: 0,
        eventCount: 0,
      }
    })
    if (options.systemPrompt !== undefined) {
      await this.store.transcript(this.runId, {
        agentId: options.id,
        kind: 'system',
        content: options.systemPrompt,
      })
    }
    await this.store.transcript(this.runId, {
      agentId: options.id,
      kind: 'user',
      content: options.prompt,
    })

    try {
      let cwd = sourceCwd
      let workspace: ManagedWorkspace | undefined
      if (selectedLocation?.worktree === true) {
        const resolution = await createManagedWorkspace({
          runId: this.runId,
          runName: this.runName,
          agentId: options.id,
          cwd: sourceCwd,
          target,
          ...(selectedLocation.worktreeRevision === undefined
            ? {}
            : { revision: selectedLocation.worktreeRevision }),
        })
        cwd = resolution.cwd
        workspace = resolution.workspace
      }
      const location = resolvedLocation(target, cwd)
      if (
        options.resume !== undefined &&
        !sameLocation(location, options.resume.location)
      ) {
        throw new Error(
          `Agent ${options.id} must resume in ${JSON.stringify(options.resume.location)}, not ${JSON.stringify(location)}`,
        )
      }
      await this.store.update(this.runId, (record) => {
        const state = record.agents[options.id]
        if (state === undefined) return
        state.status = 'running'
        state.cwd = cwd
        if (workspace !== undefined) state.workspace = workspace
      })
      await this.store.event(this.runId, {
        type: 'agent.started',
        agentId: options.id,
        data: {
          model: options.model,
          harness: options.harness,
          target,
          cwd,
          workspace,
          reasoning: options.reasoning,
        },
      })
      const result = await this.consume(options, target, cwd, workspace)
      const finishedAt = new Date().toISOString()
      await this.store.update(this.runId, (record) => {
        const state = record.agents[options.id]
        if (state === undefined) return
        state.status = 'succeeded'
        state.finishedAt = finishedAt
        if (result.session !== undefined) state.session = result.session
        state.textChars = result.text.length
      })
      await this.store.event(this.runId, {
        type: 'agent.completed',
        agentId: options.id,
        data: result,
      })
      return result
    } catch (error) {
      const stopped = this.abortController.signal.aborted
      const finishedAt = new Date().toISOString()
      const message = messageOf(error)
      await this.store.update(this.runId, (record) => {
        const state = record.agents[options.id]
        if (state === undefined) return
        state.status = stopped ? 'stopped' : 'failed'
        state.finishedAt = finishedAt
        state.error = message
      })
      await this.store.event(this.runId, {
        type: stopped ? 'agent.stopped' : 'agent.failed',
        agentId: options.id,
        data: { error: message },
      })
      throw error
    }
  }

  private async consume(
    options: AgentRunOptions,
    target: Target,
    cwd: string,
    workspace: ManagedWorkspace | undefined,
  ): Promise<AgentResult> {
    const provider =
      target.kind === 'local'
        ? localProcessSandbox({ dir: cwd, scrubEnv: SUBSCRIPTION_API_KEYS })
        : sshProcessSandbox({
            host: target.host,
            dir: cwd,
            ...(target.sshArgs === undefined ? {} : { sshArgs: target.sshArgs }),
            scrubEnv: SUBSCRIPTION_API_KEYS,
          })

    const sandbox = defineSandbox({
      id: `${this.runId}-${options.id}`,
      provider,
      workspace: defineWorkspace({ source: { type: 'none' } }),
      lifecycle: { reuse: 'thread' },
    })
    const adapter = buildAdapter(options)
    const modelOptions = {
      ...(options.resume === undefined ? {} : { sessionId: options.resume.id }),
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    }
    const stream = chat({
      adapter,
      messages: [{ role: 'user', content: options.prompt }],
      ...(options.systemPrompt === undefined
        ? {}
        : { systemPrompts: [options.systemPrompt] }),
      modelOptions,
      abortController: this.abortController,
      middleware: [withSandbox(sandbox)],
      threadId: `${this.runId}:${options.id}`,
      runId: `${this.runId}:${options.id}:turn`,
    })

    let text = ''
    let sessionId = options.resume?.id
    try {
      for await (const chunk of stream) {
        await this.store.event(this.runId, {
          type: 'agent.event',
          agentId: options.id,
          data: chunk,
        })
        await this.store.update(this.runId, (record) => {
          const state = record.agents[options.id]
          if (state !== undefined) state.eventCount += 1
        })
        const transcript = transcriptFromChunk(options.id, chunk)
        if (transcript !== null) {
          await this.store.transcript(this.runId, transcript)
        }
        if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
          text += chunk.delta
          await this.store.update(this.runId, (record) => {
            const state = record.agents[options.id]
            if (state !== undefined) state.textChars = text.length
          })
        }
        sessionId = sessionIdFrom(chunk, sessionEventName(options.harness)) ?? sessionId
        if (chunk.type === EventType.RUN_ERROR) {
          throw new Error(chunk.message)
        }
      }
    } finally {
      await cleanupProjectionMarkers(cwd, target)
    }

    const location = resolvedLocation(target, cwd)
    const session: AgentSession | undefined =
      sessionId === undefined
        ? undefined
        : { id: sessionId, harness: options.harness, location }
    return {
      id: options.id,
      model: options.model,
      harness: options.harness,
      location,
      ...(workspace === undefined ? {} : { workspace }),
      text,
      ...(session === undefined ? {} : { session }),
    }
  }
}
