import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildHarnessDriver,
  codexTranscriptForTest,
  consumeCodexEventsForTest,
  linkedAbortControllerForTest,
  needsClaudeResultTranscriptForTest,
} from '../src/harnesses.js'
import { subscriptionEnvironment } from '../src/harness-process.js'
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

test('subscription environment removes API keys without removing user auth', () => {
  assert.deepEqual(
    subscriptionEnvironment({
      ANTHROPIC_API_KEY: 'api-key',
      CODEX_API_KEY: 'codex-key',
      OPENAI_API_KEY: 'openai-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
      PATH: '/bin',
    }),
    {
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
      PATH: '/bin',
    },
  )
})

test('Claude rejects reasoning levels its SDK does not expose', async () => {
  const driver = buildHarnessDriver(
    options({
      harness: 'claude-code',
      model: 'claude-haiku-4-5',
      reasoning: 'minimal',
    }),
    { kind: 'local' },
    process.cwd(),
    new AbortController().signal,
  )
  await assert.rejects(
    driver.run({ event: async () => {}, transcript: async () => {} }),
    /does not support reasoning level minimal/,
  )
})

test('Codex rejects unsupported max reasoning and turn limits', () => {
  assert.throws(
    () =>
      buildHarnessDriver(
        options({ reasoning: 'low', maxTurns: 1 }),
        { kind: 'local' },
        process.cwd(),
        new AbortController().signal,
      ),
    /does not support maxTurns/,
  )
})

test('Codex completed messages normalize to readable transcript entries', () => {
  assert.deepEqual(
    codexTranscriptForTest({
      type: 'item.completed',
      item: { id: 'answer', type: 'agent_message', text: 'Readable answer' },
    }),
    { kind: 'assistant', content: 'Readable answer', messageId: 'answer' },
  )
})

test('Codex rejects a completed turn without an agent message', async () => {
  async function* events() {
    yield { type: 'turn.started' } as const
    yield {
      type: 'turn.completed',
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    } as const
  }

  await assert.rejects(
    consumeCodexEventsForTest(
      events(),
      { event: async () => {}, transcript: async () => {} },
      undefined,
    ),
    /Codex ended without an agent message/,
  )
})

test('Claude archives structured result text when no assistant text carried it', () => {
  assert.equal(needsClaudeResultTranscriptForTest(new Set(), '{"ok":true}'), true)
  assert.equal(
    needsClaudeResultTranscriptForTest(new Set(['{"ok":true}']), '{"ok":true}'),
    false,
  )
})

test('Claude links a workflow signal that is already aborted', () => {
  const source = new AbortController()
  source.abort(new Error('stopped'))
  const linked = linkedAbortControllerForTest(source.signal)
  assert.equal(linked.signal.aborted, true)
  assert.equal(linked.signal.reason, source.signal.reason)
})
