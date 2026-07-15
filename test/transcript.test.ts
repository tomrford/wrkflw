import assert from 'node:assert/strict'
import test from 'node:test'
import { formatTranscriptText, textTranscriptEntries } from '../src/transcript.js'
import type { TranscriptEntry } from '../src/types.js'

function entry(
  seq: number,
  content: string,
  overrides: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    seq,
    at: '2026-07-15T00:00:00.000Z',
    runId: 'run-one',
    agentId: 'review',
    kind: 'assistant',
    content,
    messageId: 'message-one',
    ...overrides,
  }
}

test('text transcripts coalesce streaming message deltas', () => {
  const entries = textTranscriptEntries([
    entry(10, 'A'),
    entry(12, ' readable'),
    entry(14, ' answer.'),
    entry(16, 'tool', { kind: 'tool', messageId: 'tool-one' }),
    entry(18, 'Another message.', { messageId: 'message-two' }),
  ])

  assert.equal(entries.length, 3)
  assert.equal(
    formatTranscriptText(entries),
    '[10-14] review assistant: A readable answer.\n' +
      '[16] review tool: tool\n' +
      '[18] review assistant: Another message.\n',
  )
})

test('text transcripts retain unidentified deltas as separate entries', () => {
  const first = entry(1, 'first')
  const second = entry(2, 'second')
  delete first.messageId
  delete second.messageId
  const entries = textTranscriptEntries([first, second])

  assert.equal(entries.length, 2)
})
