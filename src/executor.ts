import { buildHarnessDriver } from './harnesses.js'
import { isAbsolute } from 'node:path'
import { preflightAgents } from './preflight.js'
import { HARNESS_NAMES, REASONING_LEVELS } from './types.js'
import { createManagedWorkspace } from './workspaces.js'
import type { HarnessDriverFactory } from './harnesses.js'
import type { RunStore } from './store.js'
import type {
  AgentResult,
  AgentRunOptions,
  AgentSession,
  ManagedWorkspace,
  OutputSchema,
  ResolvedLocation,
  SchemaOutput,
  Target,
  WorkflowContext,
} from './types.js'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function validate(options: AgentRunOptions): void {
  if (!options.id.trim()) throw new Error('Agent run id is required')
  if (!options.model.trim())
    throw new Error(`Agent ${options.id} needs an exact model ID`)
  if (!options.prompt.trim()) throw new Error(`Agent ${options.id} needs a prompt`)
  if (!HARNESS_NAMES.includes(options.harness as (typeof HARNESS_NAMES)[number])) {
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
  if (options.location?.target?.kind === 'ssh') {
    const cwd = options.location.cwd
    if (cwd === undefined) {
      throw new Error(`Agent ${options.id} needs an explicit cwd for an SSH location`)
    }
    if (!isAbsolute(cwd)) {
      throw new Error(`Agent ${options.id} needs an absolute cwd for an SSH location`)
    }
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

function formatPath(
  path: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined,
) {
  if (path === undefined || path.length === 0) return '$'
  return `$${path
    .map((segment) => {
      const key = typeof segment === 'object' ? segment.key : segment
      return typeof key === 'number' ? `[${key}]` : `.${String(key)}`
    })
    .join('')}`
}

async function validateStructuredOutput<Schema extends OutputSchema>(
  schema: Schema,
  text: string,
  nativeOutput: unknown,
): Promise<SchemaOutput<Schema>> {
  let candidate = nativeOutput
  if (candidate === undefined) {
    try {
      candidate = JSON.parse(text)
    } catch (error) {
      throw new Error('Harness returned invalid JSON for structured output', {
        cause: error,
      })
    }
  }
  const result = await schema['~standard'].validate(candidate)
  if (result.issues !== undefined) {
    const details = result.issues
      .map((issue) => `${formatPath(issue.path)}: ${issue.message}`)
      .join('; ')
    throw new Error(`Harness returned invalid structured output: ${details}`)
  }
  return result.value
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
    private readonly driverFactory: HarnessDriverFactory = buildHarnessDriver,
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

  private async runAgent<Schema extends OutputSchema | undefined = undefined>(
    options: AgentRunOptions<Schema>,
  ): Promise<AgentResult<Schema>> {
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
        if ('output' in result) state.output = result.output
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

  private async consume<Schema extends OutputSchema | undefined>(
    options: AgentRunOptions<Schema>,
    target: Target,
    cwd: string,
    workspace: ManagedWorkspace | undefined,
  ): Promise<AgentResult<Schema>> {
    const driver = this.driverFactory(options, target, cwd, this.abortController.signal)
    const harnessResult = await driver.run({
      event: async (event) => {
        await this.store.event(this.runId, {
          type: 'agent.event',
          agentId: options.id,
          data: event,
        })
        await this.store.update(this.runId, (record) => {
          const state = record.agents[options.id]
          if (state !== undefined) state.eventCount += 1
        })
      },
      transcript: async (entry) => {
        await this.store.transcript(this.runId, { agentId: options.id, ...entry })
      },
    })

    const location = resolvedLocation(target, cwd)
    const session: AgentSession | undefined =
      harnessResult.sessionId === undefined
        ? undefined
        : { id: harnessResult.sessionId, harness: options.harness, location }
    const output =
      options.outputSchema === undefined
        ? undefined
        : await validateStructuredOutput(
            options.outputSchema,
            harnessResult.text,
            harnessResult.structuredOutput,
          )
    return {
      id: options.id,
      model: options.model,
      harness: options.harness,
      location,
      ...(workspace === undefined ? {} : { workspace }),
      text: harnessResult.text,
      ...(session === undefined ? {} : { session }),
      ...(options.outputSchema === undefined ? {} : { output }),
    } as AgentResult<Schema>
  }
}
