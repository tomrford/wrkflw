import type { TranscriptEntry } from './types.js'

interface TextTranscriptEntry extends TranscriptEntry {
  lastSeq: number
}

function canJoin(current: TextTranscriptEntry, next: TranscriptEntry): boolean {
  return (
    current.messageId !== undefined &&
    current.messageId === next.messageId &&
    current.agentId === next.agentId &&
    current.kind === next.kind &&
    (current.kind === 'assistant' || current.kind === 'reasoning')
  )
}

export function textTranscriptEntries(
  entries: ReadonlyArray<TranscriptEntry>,
): Array<TextTranscriptEntry> {
  const result: Array<TextTranscriptEntry> = []
  for (const entry of entries) {
    const current = result.at(-1)
    if (current !== undefined && canJoin(current, entry)) {
      current.content += entry.content
      current.lastSeq = entry.seq
      continue
    }
    result.push({ ...entry, lastSeq: entry.seq })
  }
  return result
}

export function formatTranscriptText(
  entries: ReadonlyArray<TextTranscriptEntry>,
): string {
  return entries
    .map((entry) => {
      const seq =
        entry.seq === entry.lastSeq ? `${entry.seq}` : `${entry.seq}-${entry.lastSeq}`
      return `[${seq}] ${entry.agentId} ${entry.kind}: ${entry.content}\n`
    })
    .join('')
}
