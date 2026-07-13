import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAdapter } from '../src/harnesses.js'
import type { AgentRunOptions } from '../src/types.js'

function options(overrides: Partial<AgentRunOptions>): AgentRunOptions {
  return {
    id: 'test',
    harness: 'codex',
    model: 'gpt-5.6-luna',
    reasoning: 'low',
    prompt: 'Reply with OK.',
    ...overrides,
  }
}

test('adapters retain exact model IDs', () => {
  const adapter = buildAdapter(options({}))
  assert.equal(adapter.model, 'gpt-5.6-luna')
})

test('Claude rejects reasoning levels its CLI does not expose', () => {
  assert.throws(
    () =>
      buildAdapter(
        options({
          harness: 'claude-code',
          model: 'claude-haiku-4-5',
          reasoning: 'minimal',
        }),
      ),
    /does not support reasoning level minimal/,
  )
})

test('Cursor uses ACP with a reasoning-suffixed and shell-safe model ID', () => {
  const adapter = buildAdapter(
    options({
      harness: 'cursor-acp',
      model: "gpt-5.6-luna'preview",
      reasoning: 'high',
    }),
  )
  const harness = Reflect.get(adapter, 'harness') as {
    command: (context: unknown) => string
  }
  assert.equal(harness.command({}), "agent --model 'gpt-5.6-luna'\\''preview-high' acp")
})
