import { randomUUID } from 'node:crypto'
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RunEvent, RunRecord, TranscriptEntry } from './types.js'

export function stateDirectory(): string {
  return process.env.WRKFLW_STATE_DIR ?? join(homedir(), '.wrkflw', 'state')
}

export function runDirectory(runId: string): string {
  return join(stateDirectory(), 'runs', runId)
}

function recordPath(runId: string): string {
  return join(runDirectory(runId), 'run.json')
}

export class RunStore {
  private queue: Promise<void> = Promise.resolve()
  private sequence = new Map<string, number>()
  private transcriptSequence = new Map<string, number>()

  async create(record: RunRecord): Promise<void> {
    await mkdir(runDirectory(record.id), { recursive: true })
    await this.write(record)
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
      const seq = (this.sequence.get(runId) ?? 0) + 1
      this.sequence.set(runId, seq)
      const result: RunEvent = {
        seq,
        at: new Date().toISOString(),
        runId,
        ...event,
      }
      await appendFile(
        join(runDirectory(runId), 'events.ndjson'),
        `${JSON.stringify(result)}\n`,
      )
      return result
    })
  }

  async events(runId: string): Promise<Array<RunEvent>> {
    try {
      const text = await readFile(join(runDirectory(runId), 'events.ndjson'), 'utf8')
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunEvent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async transcript(
    runId: string,
    entry: Omit<TranscriptEntry, 'seq' | 'at' | 'runId'>,
  ): Promise<TranscriptEntry> {
    return this.enqueue(async () => {
      const seq = (this.transcriptSequence.get(runId) ?? 0) + 1
      this.transcriptSequence.set(runId, seq)
      const result: TranscriptEntry = {
        seq,
        at: new Date().toISOString(),
        runId,
        ...entry,
      }
      await appendFile(
        join(runDirectory(runId), 'transcript.ndjson'),
        `${JSON.stringify(result)}\n`,
      )
      return result
    })
  }

  async transcripts(runId: string): Promise<Array<TranscriptEntry>> {
    try {
      const text = await readFile(
        join(runDirectory(runId), 'transcript.ndjson'),
        'utf8',
      )
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TranscriptEntry)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
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

  private async write(record: RunRecord): Promise<void> {
    const target = recordPath(record.id)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`)
    await rename(temporary, target)
  }
}
