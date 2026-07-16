import { query } from '@anthropic-ai/claude-agent-sdk'
import { Codex } from '@openai/codex-sdk'
import {
  createCodexSshShim,
  spawnClaudeOverSsh,
  subscriptionEnvironment,
} from './harness-process.js'
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk'
import type {
  AgentRunOptions,
  ReasoningLevel,
  Target,
  TranscriptKind,
} from './types.js'

export interface HarnessTranscript {
  kind: TranscriptKind
  content: string
  messageId?: string
  data?: unknown
}

export interface HarnessSink {
  event(value: unknown): Promise<void>
  transcript(value: HarnessTranscript): Promise<void>
}

export interface HarnessResult {
  text: string
  sessionId?: string
  structuredOutput?: unknown
}

export interface HarnessDriver {
  run(sink: HarnessSink): Promise<HarnessResult>
}

export type HarnessDriverFactory = (
  options: AgentRunOptions,
  target: Target,
  cwd: string,
  signal: AbortSignal,
) => HarnessDriver

function claudeEffort(
  reasoning: ReasoningLevel | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (reasoning === undefined) return undefined
  if (reasoning === 'none' || reasoning === 'minimal') {
    throw new Error(`Claude Code does not support reasoning level ${reasoning}`)
  }
  return reasoning
}

function codexEffort(
  reasoning: ReasoningLevel | undefined,
): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (reasoning === undefined) return undefined
  if (reasoning === 'none') return 'minimal'
  if (reasoning === 'max') {
    throw new Error('Codex does not support reasoning level max')
  }
  return reasoning
}

function content(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value)
}

function needsClaudeResultTranscript(
  assistantResponses: ReadonlySet<string>,
  result: string,
): boolean {
  return result !== '' && !assistantResponses.has(result)
}

function linkedAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) controller.abort(signal.reason)
  else {
    signal.addEventListener('abort', () => controller.abort(signal.reason), {
      once: true,
    })
  }
  return controller
}

async function emitClaudeTranscripts(
  message: SDKMessage,
  sink: HarnessSink,
): Promise<string | undefined> {
  if (message.type === 'assistant') {
    let response = ''
    for (const block of message.message.content) {
      if (block.type === 'text') {
        response += block.text
        await sink.transcript({
          kind: 'assistant',
          content: block.text,
          messageId: message.uuid,
        })
      } else if (block.type === 'thinking') {
        await sink.transcript({
          kind: 'reasoning',
          content: block.thinking,
          messageId: message.uuid,
        })
      } else if (block.type === 'tool_use') {
        await sink.transcript({
          kind: 'tool',
          content: block.name,
          messageId: block.id,
          data: block,
        })
      }
    }
    return response || undefined
  } else if (message.type === 'user') {
    const blocks = Array.isArray(message.message.content)
      ? message.message.content
      : [message.message.content]
    for (const block of blocks) {
      if (typeof block !== 'string' && block.type === 'tool_result') {
        await sink.transcript({
          kind: 'tool-result',
          content: content(block.content),
          messageId: block.tool_use_id,
          data: block,
        })
      }
    }
  }
  return undefined
}

function claudeDriver(
  options: AgentRunOptions,
  target: Target,
  cwd: string,
  signal: AbortSignal,
): HarnessDriver {
  return {
    async run(sink) {
      const abortController = linkedAbortController(signal)
      const effort = claudeEffort(options.reasoning)
      const stream = query({
        prompt: options.prompt,
        options: {
          cwd,
          model: options.model,
          pathToClaudeCodeExecutable: 'claude',
          settingSources: ['user', 'project', 'local'],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          abortController,
          ...(options.systemPrompt === undefined
            ? { systemPrompt: { type: 'preset', preset: 'claude_code' } as const }
            : {
                systemPrompt: {
                  type: 'preset',
                  preset: 'claude_code',
                  append: options.systemPrompt,
                } as const,
              }),
          ...(effort === undefined ? {} : { effort }),
          ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
          ...(options.resume === undefined ? {} : { resume: options.resume.id }),
          ...(options.outputSchema === undefined
            ? {}
            : {
                outputFormat: {
                  type: 'json_schema',
                  schema: options.outputSchema['~standard'].jsonSchema.output({
                    target: 'draft-07',
                  }),
                } as const,
              }),
          ...(target.kind === 'local'
            ? { env: subscriptionEnvironment() }
            : {
                spawnClaudeCodeProcess: (spawnOptions) =>
                  spawnClaudeOverSsh(target, cwd, spawnOptions),
              }),
        },
      })
      let result: SDKResultMessage | undefined
      const assistantResponses = new Set<string>()
      for await (const message of stream) {
        await sink.event(message)
        const response = await emitClaudeTranscripts(message, sink)
        if (response !== undefined) assistantResponses.add(response)
        if (message.type === 'result') result = message
      }
      if (result === undefined) throw new Error('Claude Code ended without a result')
      if (result.subtype !== 'success') {
        throw new Error(
          result.errors.join('\n') || `Claude Code failed: ${result.subtype}`,
        )
      }
      if (needsClaudeResultTranscript(assistantResponses, result.result)) {
        await sink.transcript({
          kind: 'assistant',
          content: result.result,
          messageId: result.uuid,
        })
      }
      return {
        text: result.result,
        sessionId: result.session_id,
        ...(result.structured_output === undefined
          ? {}
          : { structuredOutput: result.structured_output }),
      }
    },
  }
}

function transcriptFromCodexItem(item: ThreadItem): HarnessTranscript | undefined {
  switch (item.type) {
    case 'agent_message':
      return { kind: 'assistant', content: item.text, messageId: item.id }
    case 'reasoning':
      return { kind: 'reasoning', content: item.text, messageId: item.id }
    case 'command_execution':
      return {
        kind: item.status === 'completed' ? 'tool-result' : 'tool',
        content: item.status === 'completed' ? item.aggregated_output : item.command,
        messageId: item.id,
        data: item,
      }
    case 'mcp_tool_call':
      return {
        kind: item.status === 'completed' ? 'tool-result' : 'tool',
        content:
          item.status === 'completed'
            ? content(item.result?.structured_content)
            : `${item.server}.${item.tool}`,
        messageId: item.id,
        data: item,
      }
    case 'file_change':
      return {
        kind: 'tool-result',
        content: item.changes
          .map((change) => `${change.kind} ${change.path}`)
          .join('\n'),
        messageId: item.id,
        data: item,
      }
    case 'web_search':
      return { kind: 'tool', content: item.query, messageId: item.id, data: item }
    case 'error':
      return { kind: 'error', content: item.message, messageId: item.id, data: item }
    case 'todo_list':
      return undefined
  }
}

async function consumeCodexEvents(
  events: AsyncIterable<ThreadEvent>,
  sink: HarnessSink,
  initialSessionId?: string,
): Promise<HarnessResult> {
  let text: string | undefined
  let sessionId = initialSessionId
  for await (const event of events) {
    await sink.event(event)
    if (event.type === 'thread.started') sessionId = event.thread_id
    if (event.type === 'turn.failed' || event.type === 'error') {
      throw new Error(
        event.type === 'turn.failed' ? event.error.message : event.message,
      )
    }
    if (
      event.type === 'item.started' &&
      (event.item.type === 'command_execution' ||
        event.item.type === 'mcp_tool_call' ||
        event.item.type === 'web_search')
    ) {
      const transcript = transcriptFromCodexItem(event.item)
      if (transcript !== undefined) await sink.transcript(transcript)
    }
    if (event.type === 'item.completed') {
      const transcript = transcriptFromCodexItem(event.item)
      if (transcript !== undefined) await sink.transcript(transcript)
      if (event.item.type === 'agent_message') text = event.item.text
    }
  }
  if (text === undefined) throw new Error('Codex ended without an agent message')
  return { text, ...(sessionId === undefined ? {} : { sessionId }) }
}

function codexDriver(
  options: AgentRunOptions,
  target: Target,
  cwd: string,
  signal: AbortSignal,
): HarnessDriver {
  return {
    async run(sink) {
      const shim =
        target.kind === 'ssh' ? await createCodexSshShim(target, cwd) : undefined
      try {
        const effort = codexEffort(options.reasoning)
        const codex = new Codex({
          codexPathOverride: shim?.path ?? 'codex',
          env: subscriptionEnvironment(),
          ...(options.systemPrompt === undefined
            ? {}
            : { config: { developer_instructions: options.systemPrompt } }),
        })
        const threadOptions = {
          model: options.model,
          workingDirectory: cwd,
          sandboxMode: 'workspace-write' as const,
          approvalPolicy: 'never' as const,
          skipGitRepoCheck: true,
          ...(effort === undefined ? {} : { modelReasoningEffort: effort }),
        }
        const thread =
          options.resume === undefined
            ? codex.startThread(threadOptions)
            : codex.resumeThread(options.resume.id, threadOptions)
        const streamed = await thread.runStreamed(options.prompt, {
          signal,
          ...(options.outputSchema === undefined
            ? {}
            : {
                outputSchema: options.outputSchema['~standard'].jsonSchema.output({
                  target: 'draft-07',
                }),
              }),
        })
        return consumeCodexEvents(streamed.events, sink, options.resume?.id)
      } finally {
        await shim?.cleanup()
      }
    },
  }
}

export const buildHarnessDriver: HarnessDriverFactory = (
  options,
  target,
  cwd,
  signal,
) => {
  switch (options.harness) {
    case 'claude-code':
      return claudeDriver(options, target, cwd, signal)
    case 'codex':
      if (options.maxTurns !== undefined) {
        throw new Error('Codex does not support maxTurns')
      }
      return codexDriver(options, target, cwd, signal)
  }
}

export const codexTranscriptForTest = (
  event: ThreadEvent,
): HarnessTranscript | undefined =>
  event.type === 'item.completed' ? transcriptFromCodexItem(event.item) : undefined

export const needsClaudeResultTranscriptForTest = needsClaudeResultTranscript
export const linkedAbortControllerForTest = linkedAbortController
export const consumeCodexEventsForTest = consumeCodexEvents
