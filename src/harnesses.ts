import { acpCompatible } from '@tanstack/ai-acp'
import { claudeCodeText } from '@tanstack/ai-claude-code'
import { codexText } from '@tanstack/ai-codex'
import type { AnyTextAdapter } from '@tanstack/ai'
import type { AgentRunOptions, ReasoningLevel } from './types.js'

function assertClaudeReasoning(
  reasoning: ReasoningLevel | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (reasoning === undefined) return undefined
  if (reasoning === 'none' || reasoning === 'minimal') {
    throw new Error(`Claude Code does not support reasoning level ${reasoning}`)
  }
  return reasoning
}

function cursorModel(model: string, reasoning: ReasoningLevel | undefined): string {
  if (reasoning === undefined) return model
  const effort = reasoning === 'minimal' ? 'none' : reasoning
  return `${model}-${effort}`
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildAdapter(options: AgentRunOptions): AnyTextAdapter {
  switch (options.harness) {
    case 'claude-code': {
      const reasoning = assertClaudeReasoning(options.reasoning)
      return claudeCodeText(options.model, {
        ...(reasoning === undefined
          ? {}
          : { claudeExecutable: `claude --effort ${reasoning}` }),
        ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
        emitDiff: false,
      })
    }
    case 'codex': {
      const reasoning = options.reasoning === 'none' ? 'minimal' : options.reasoning
      return codexText(
        options.model,
        reasoning === undefined
          ? {}
          : { config: { model_reasoning_effort: `"${reasoning}"` } },
      )
    }
    case 'cursor-acp': {
      const cursor = acpCompatible({
        name: 'cursor-acp',
        command: () =>
          `agent --model ${quote(cursorModel(options.model, options.reasoning))} acp`,
        emitDiff: false,
      })
      return cursor(options.model)
    }
  }
}

export const sessionEventName = (harness: AgentRunOptions['harness']): string =>
  `${harness}.session-id`
