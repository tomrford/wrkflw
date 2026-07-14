import { randomUUID } from 'node:crypto'
import {
  appendFile,
  open,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JournalEntry, RunEvent, RunRecord, TranscriptEntry } from './types.js'

export function stateDirectory(): string {
  return process.env.WRKFLW_STATE_DIR ?? join(homedir(), '.wrkflw', 'state')
}

export function runDirectory(runId: string): string {
  return join(stateDirectory(), 'runs', runId)
}

function recordPath(runId: string): string {
  return join(runDirectory(runId), 'summary.json')
}

function journalPath(runId: string): string {
  return join(runDirectory(runId), 'journal.ndjson')
}

function nameReservationDirectory(name: string): string {
  return join(stateDirectory(), 'active-names', name)
}

export interface NameReservation {
  id: string
  createdAt: string
}

export class RunStore {
  private queue: Promise<void> = Promise.resolve()
  private sequence = new Map<string, number>()

  async prepare(runId: string): Promise<void> {
    await mkdir(runDirectory(runId), { recursive: true })
  }

  async create(record: RunRecord): Promise<void> {
    await this.prepare(record.id)
    await this.write(record)
  }

  async remove(runId: string): Promise<void> {
    await rm(runDirectory(runId), { recursive: true, force: true })
  }

  async reserveName(name: string, reservation: NameReservation): Promise<boolean> {
    const root = join(stateDirectory(), 'active-names')
    const directory = nameReservationDirectory(name)
    await mkdir(root, { recursive: true })
    try {
      await mkdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    try {
      await writeFile(join(directory, 'owner.json'), `${JSON.stringify(reservation)}\n`)
      return true
    } catch (error) {
      await rmdir(directory).catch(() => undefined)
      throw error
    }
  }

  async nameReservation(name: string): Promise<NameReservation | undefined> {
    const directory = nameReservationDirectory(name)
    try {
      const text = await readFile(join(directory, 'owner.json'), 'utf8')
      return JSON.parse(text) as NameReservation
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        const metadata = await stat(directory)
        return { id: '', createdAt: metadata.mtime.toISOString() }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw statError
      }
    }
  }

  async releaseName(name: string, reservationId: string): Promise<boolean> {
    const current = await this.nameReservation(name)
    if (current === undefined || current.id !== reservationId) return false
    const directory = nameReservationDirectory(name)
    await unlink(join(directory, 'owner.json')).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    try {
      await rmdir(directory)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
  }

  async get(runId: string): Promise<RunRecord> {
    const text = await readFile(recordPath(runId), 'utf8')
    return JSON.parse(text) as RunRecord
  }

  async resolve(reference: string): Promise<RunRecord> {
    const records = await this.list()
    const exactId = records.find((record) => record.id === reference)
    if (exactId !== undefined) return exactId
    const named = records.find((record) => record.name === reference)
    if (named !== undefined) return named
    throw new Error(`Unknown run ${JSON.stringify(reference)}`)
  }

  async list(): Promise<Array<RunRecord>> {
    const root = join(stateDirectory(), 'runs')
    let entries: Array<string>
    try {
      entries = await readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records = await Promise.all(
      entries.map(async (entry) => {
        try {
          return await this.get(entry)
        } catch {
          return null
        }
      }),
    )
    return records
      .filter((record): record is RunRecord => record !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async update(
    runId: string,
    mutate: (record: RunRecord) => RunRecord | undefined,
  ): Promise<RunRecord> {
    return this.enqueue(async () => {
      const current = await this.get(runId)
      const result = mutate(current) ?? current
      await this.write(result)
      return result
    })
  }

  async event(
    runId: string,
    event: Omit<RunEvent, 'seq' | 'at' | 'runId'>,
  ): Promise<RunEvent> {
    return this.enqueue(async () => {
      const seq = await this.nextSequence(runId)
      const result: RunEvent = {
        seq,
        at: new Date().toISOString(),
        runId,
        ...event,
      }
      const journal: JournalEntry = { channel: 'event', ...result }
      await appendFile(journalPath(runId), `${JSON.stringify(journal)}\n`)
      return result
    })
  }

  async events(runId: string): Promise<Array<RunEvent>> {
    return (await this.journal(runId))
      .filter((entry) => entry.channel === 'event')
      .map(({ channel: _, ...event }) => event)
  }

  async transcript(
    runId: string,
    entry: Omit<TranscriptEntry, 'seq' | 'at' | 'runId'>,
  ): Promise<TranscriptEntry> {
    return this.enqueue(async () => {
      const seq = await this.nextSequence(runId)
      const result: TranscriptEntry = {
        seq,
        at: new Date().toISOString(),
        runId,
        ...entry,
      }
      const { kind, ...rest } = result
      const journal: JournalEntry = {
        channel: 'transcript',
        transcriptKind: kind,
        ...rest,
      }
      await appendFile(journalPath(runId), `${JSON.stringify(journal)}\n`)
      return result
    })
  }

  async transcripts(runId: string): Promise<Array<TranscriptEntry>> {
    return (await this.journal(runId))
      .filter((entry) => entry.channel === 'transcript')
      .map(({ channel: _, transcriptKind, ...entry }) => ({
        ...entry,
        kind: transcriptKind,
      }))
  }

  async journal(runId: string): Promise<Array<JournalEntry>> {
    try {
      const text = await readFile(journalPath(runId), 'utf8')
      const lines = text.split('\n')
      const entries: Array<JournalEntry> = []
      for (const [index, line] of lines.entries()) {
        if (!line) continue
        try {
          entries.push(JSON.parse(line) as JournalEntry)
        } catch (error) {
          if (index === lines.length - 1) break
          throw error
        }
      }
      return entries
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async journalChunk(
    runId: string,
    offset = 0,
  ): Promise<{ entries: Array<JournalEntry>; nextOffset: number }> {
    let file: Awaited<ReturnType<typeof open>>
    try {
      file = await open(journalPath(runId), 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { entries: [], nextOffset: offset }
      }
      throw error
    }
    try {
      const size = (await file.stat()).size
      if (size <= offset) return { entries: [], nextOffset: offset }
      const buffer = Buffer.alloc(size - offset)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      const text = buffer.subarray(0, bytesRead).toString('utf8')
      const completeThrough = text.lastIndexOf('\n')
      if (completeThrough === -1) return { entries: [], nextOffset: offset }
      const complete = text.slice(0, completeThrough + 1)
      return {
        entries: complete
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as JournalEntry),
        nextOffset: offset + Buffer.byteLength(complete),
      }
    } finally {
      await file.close()
    }
  }

  newId(): string {
    return randomUUID()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => undefined).then(operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async nextSequence(runId: string): Promise<number> {
    let previous = this.sequence.get(runId)
    if (previous === undefined) {
      previous = (await this.journal(runId)).at(-1)?.seq ?? 0
    }
    const next = previous + 1
    this.sequence.set(runId, next)
    return next
  }

  private async write(record: RunRecord): Promise<void> {
    const target = recordPath(record.id)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`)
    await rename(temporary, target)
  }
}
