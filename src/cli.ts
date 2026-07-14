#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { cleanupRunWorkspaces } from './cleanup.js'
import { renderSkill, skillTopics } from './skill.js'
import { RunStore, runDirectory } from './store.js'
import { reconcileRun, reconcileRuns, startRun, stopRun } from './supervisor.js'
import { TRANSCRIPT_KINDS } from './types.js'
import { runWorker } from './worker.js'
import type {
  JournalEntry,
  RunEvent,
  RunRecord,
  TranscriptEntry,
  TranscriptKind,
} from './types.js'

const TERMINAL = new Set(['succeeded', 'failed', 'crashed', 'stopped'])
const NAME_RESERVATION_GRACE_MS = 30_000

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function jsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function option(args: Array<string>, name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function has(args: Array<string>, name: string): boolean {
  return args.includes(name)
}

function withoutOptions(args: Array<string>, valued: Array<string>): Array<string> {
  const result: Array<string> = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === undefined) continue
    if (valued.includes(value)) {
      index += 1
      continue
    }
    if (value.startsWith('--')) continue
    result.push(value)
  }
  return result
}

function numberOption(
  args: Array<string>,
  name: string,
  options: { minimum?: number } = {},
): number | undefined {
  const value = option(args, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < (options.minimum ?? 0)) {
    throw new Error(`${name} must be an integer of at least ${options.minimum ?? 0}`)
  }
  return parsed
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
}

function eventMatches(
  event: RunEvent,
  filters: { agent: string | undefined; after: number | undefined },
): boolean {
  if (filters.agent !== undefined && event.agentId !== filters.agent) return false
  if (filters.after !== undefined && event.seq <= filters.after) return false
  return true
}

function journalMatches(
  entry: JournalEntry,
  filters: { agent: string | undefined; after: number | undefined },
): boolean {
  if (filters.agent !== undefined && entry.agentId !== filters.agent) return false
  if (filters.after !== undefined && entry.seq <= filters.after) return false
  return true
}

function transcriptKind(args: Array<string>): TranscriptKind | undefined {
  const kind = option(args, '--kind')
  if (kind === undefined) return undefined
  if (!TRANSCRIPT_KINDS.includes(kind as TranscriptKind)) {
    throw new Error(`--kind must be one of ${TRANSCRIPT_KINDS.join(', ')}`)
  }
  return kind as TranscriptKind
}

function transcriptMatches(
  entry: TranscriptEntry,
  filters: {
    agent: string | undefined
    kind: TranscriptKind | undefined
    after: number | undefined
    before: number | undefined
  },
): boolean {
  if (filters.agent !== undefined && entry.agentId !== filters.agent) return false
  if (filters.kind !== undefined && entry.kind !== filters.kind) return false
  if (filters.after !== undefined && entry.seq <= filters.after) return false
  if (filters.before !== undefined && entry.seq >= filters.before) return false
  return true
}

async function reconciledRecord(
  store: RunStore,
  reference: string,
): Promise<RunRecord> {
  const record = await store.resolve(reference)
  return reconcileRun(record)
}

async function follow(
  store: RunStore,
  reference: string,
  detail: string,
  agent: string | undefined,
): Promise<void> {
  if (!['summary', 'journal', 'raw'].includes(detail)) {
    throw new Error('--detail must be summary, journal or raw')
  }
  const initial = await store.resolve(reference)
  let offset = 0
  let terminalObserved = false
  while (true) {
    const chunk = await store.journalChunk(initial.id, offset)
    for (const entry of chunk.entries) {
      if (!journalMatches(entry, { agent, after: undefined })) continue
      if (
        detail === 'summary' &&
        (entry.channel !== 'event' || entry.type === 'agent.event')
      ) {
        continue
      }
      if (detail === 'raw') {
        if (entry.channel === 'event' && entry.type === 'agent.event') {
          jsonLine(entry.data)
        }
        continue
      }
      jsonLine(entry)
    }
    offset = chunk.nextOffset
    const record = await reconciledRecord(store, initial.id)
    const terminal = TERMINAL.has(record.status)
    if (terminalObserved && terminal && chunk.entries.length === 0) return
    terminalObserved ||= terminal
    await sleep(250)
  }
}

async function info(
  store: RunStore,
  reference: string,
  agentId: string | undefined,
): Promise<void> {
  const record = await reconciledRecord(store, reference)
  const journal = await store.journal(record.id)
  const transcriptEntries = journal.filter((entry) => entry.channel === 'transcript')
  if (agentId === undefined) {
    json({
      ...record,
      warningCount: record.warnings.filter((warning) => !warning.resolvedAt).length,
      journalEntries: journal.length,
      transcriptEntries: transcriptEntries.length,
    })
    return
  }
  const state = record.agents[agentId]
  if (state === undefined) throw new Error(`Run ${record.name} has no agent ${agentId}`)
  const completed = journal
    .filter(
      (entry) =>
        entry.channel === 'event' &&
        entry.agentId === agentId &&
        entry.type === 'agent.completed',
    )
    .at(-1)
  json({
    runId: record.id,
    runName: record.name,
    ...state,
    transcriptEntries: transcriptEntries.filter((entry) => entry.agentId === agentId)
      .length,
    ...(completed === undefined ? {} : { result: completed.data }),
  })
}

function durationMilliseconds(value: string): number {
  const match = /^(\d+)(m|h|d|w)$/.exec(value)
  if (match === null) throw new Error('--older-than must use m, h, d or w')
  const count = Number(match[1])
  const unit = match[2]
  const factor =
    unit === 'm'
      ? 60_000
      : unit === 'h'
        ? 60 * 60_000
        : unit === 'd'
          ? 24 * 60 * 60_000
          : 7 * 24 * 60 * 60_000
  return count * factor
}

async function reserveRunName(
  store: RunStore,
  name: string,
  id: string,
): Promise<void> {
  const reservation = { id, createdAt: new Date().toISOString() }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await store.reserveName(name, reservation)) return
    const current = await store.nameReservation(name)
    if (current === undefined) continue
    let terminalReservation = false
    if (current.id !== '') {
      try {
        const run = reconcileRun(await store.get(current.id))
        if (!TERMINAL.has(run.status)) {
          throw new Error(`Run ${JSON.stringify(name)} is already ${run.status}`)
        }
        terminalReservation = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const age = Date.now() - Date.parse(current.createdAt)
    if (!terminalReservation && age < NAME_RESERVATION_GRACE_MS) {
      throw new Error(`Run ${JSON.stringify(name)} is already starting`)
    }
    await store.releaseName(name, current.id)
  }
  throw new Error(`Cannot reserve run name ${JSON.stringify(name)}`)
}

async function runCommand(args: Array<string>, cliPath: string): Promise<void> {
  const separator = args.indexOf('--')
  const commandArgs = separator === -1 ? args : args.slice(0, separator)
  const workflowArgs = separator === -1 ? [] : args.slice(separator + 1)
  const positionals = withoutOptions(commandArgs, [])
  const workflow = positionals[0]
  const name = positionals[1]
  if (workflow === undefined || name === undefined) {
    throw new Error('Usage: wrkflw run <workflow.ts> <name> [-- <workflow-args>]')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(
      'Run name must use 1 to 64 letters, numbers, dots, dashes or underscores',
    )
  }
  const store = new RunStore()
  const active = (await reconcileRuns(store)).find(
    (record) => record.name === name && !TERMINAL.has(record.status),
  )
  if (active !== undefined) {
    throw new Error(`Run ${JSON.stringify(name)} is already ${active.status}`)
  }
  const id = store.newId()
  await reserveRunName(store, name, id)
  let record: RunRecord
  try {
    record = await startRun({
      id,
      name,
      workflow,
      args: workflowArgs,
      cwd: process.cwd(),
      cliPath,
    })
  } catch (error) {
    await store.releaseName(name, id)
    throw error
  }
  if (!has(commandArgs, '--wait')) {
    json({
      runId: record.id,
      name: record.name,
      status: record.status,
      pid: record.pid,
    })
    return
  }
  while (true) {
    const current = await reconciledRecord(store, record.id)
    if (TERMINAL.has(current.status)) {
      json(current)
      if (current.status !== 'succeeded') process.exitCode = 1
      return
    }
    await sleep(250)
  }
}

async function transcriptCommand(store: RunStore, args: Array<string>): Promise<void> {
  const reference = args[0]
  if (reference === undefined) throw new Error('Usage: wrkflw transcript <run>')
  const record = await store.resolve(reference)
  const filters = {
    agent: option(args, '--agent'),
    kind: transcriptKind(args),
    after: numberOption(args, '--after'),
    before: numberOption(args, '--before', { minimum: 1 }),
  }
  let entries = (await store.transcripts(record.id)).filter((entry) =>
    transcriptMatches(entry, filters),
  )
  const limit = numberOption(args, '--limit', { minimum: 1 })
  if (limit !== undefined) entries = entries.slice(-limit)
  if ((option(args, '--format') ?? 'json') === 'text') {
    for (const entry of entries) {
      process.stdout.write(
        `[${entry.seq}] ${entry.agentId} ${entry.kind}: ${entry.content}\n`,
      )
    }
    return
  }
  json(entries)
}

async function searchCommand(store: RunStore, args: Array<string>): Promise<void> {
  const positionals = withoutOptions(args, ['--agent', '--kind', '--limit'])
  const all = has(args, '--all')
  const reference = all ? undefined : positionals[0]
  const query = all ? positionals[0] : positionals[1]
  if (query === undefined) {
    throw new Error('Usage: wrkflw search <run> <query> | wrkflw search --all <query>')
  }
  const records = await reconcileRuns(
    store,
    reference === undefined ? await store.list() : [await store.resolve(reference)],
  )
  const agent = option(args, '--agent')
  const kind = transcriptKind(args)
  const needle = query.toLocaleLowerCase()
  const matches: Array<TranscriptEntry & { runName: string }> = []
  for (const record of records) {
    for (const entry of await store.transcripts(record.id)) {
      if (agent !== undefined && entry.agentId !== agent) continue
      if (kind !== undefined && entry.kind !== kind) continue
      const haystack = `${entry.content}\n${JSON.stringify(entry.data ?? '')}`
      if (!haystack.toLocaleLowerCase().includes(needle)) continue
      matches.push({ ...entry, runName: record.name })
    }
  }
  const limit = numberOption(args, '--limit', { minimum: 1 }) ?? 100
  json(matches.slice(-limit))
}

async function journalCommand(store: RunStore, args: Array<string>): Promise<void> {
  const reference = args[0]
  if (reference === undefined) throw new Error('Usage: wrkflw journal <run>')
  const record = await store.resolve(reference)
  const filters = {
    agent: option(args, '--agent'),
    after: numberOption(args, '--after'),
  }
  let entries = (await store.journal(record.id)).filter((entry) =>
    journalMatches(entry, filters),
  )
  const limit = numberOption(args, '--limit', { minimum: 1 })
  if (limit !== undefined) entries = entries.slice(-limit)
  json(entries)
}

async function historyCommand(store: RunStore, args: Array<string>): Promise<void> {
  if (args[0] !== 'prune') {
    throw new Error('Usage: wrkflw history prune [run] [--older-than <age>]')
  }
  const positionals = withoutOptions(args.slice(1), ['--older-than'])
  const reference = positionals[0]
  const olderThan = option(args, '--older-than')
  if (reference === undefined && olderThan === undefined) {
    throw new Error('Bulk history pruning requires --older-than')
  }
  const cutoff =
    olderThan === undefined ? undefined : Date.now() - durationMilliseconds(olderThan)
  const storedRecords =
    reference === undefined ? await store.list() : [await store.resolve(reference)]
  const force = has(args, '--force')
  const output: Array<Record<string, unknown>> = []
  for (const stored of storedRecords) {
    const record = reconcileRun(stored)
    if (!TERMINAL.has(record.status)) {
      output.push({
        runId: record.id,
        name: record.name,
        pruned: false,
        reason: 'run is active',
      })
      continue
    }
    if (cutoff !== undefined && !TERMINAL.has(stored.status)) {
      output.push({
        runId: record.id,
        name: record.name,
        pruned: false,
        reason: 'terminal time is unknown; run cleanup to canonicalise the crash',
      })
      continue
    }
    const finishedAt = Date.parse(record.finishedAt ?? record.createdAt)
    if (cutoff !== undefined && finishedAt > cutoff) {
      output.push({
        runId: record.id,
        name: record.name,
        pruned: false,
        reason: 'run is newer than the retention cutoff',
      })
      continue
    }
    const retainedWorkspaces = Object.values(record.agents).filter(
      (agent) => agent.workspace !== undefined && agent.workspace.status !== 'pruned',
    )
    if (retainedWorkspaces.length > 0) {
      output.push({
        runId: record.id,
        name: record.name,
        pruned: false,
        reason: `${retainedWorkspaces.length} managed workspace${retainedWorkspaces.length === 1 ? '' : 's'} require cleanup`,
      })
      continue
    }
    const unresolved = record.warnings.filter((warning) => !warning.resolvedAt)
    if (unresolved.length > 0 && !force) {
      output.push({
        runId: record.id,
        name: record.name,
        pruned: false,
        reason: `${unresolved.length} unresolved warning${unresolved.length === 1 ? '' : 's'}`,
      })
      continue
    }
    await store.releaseName(record.name, record.id)
    await store.remove(record.id)
    output.push({ runId: record.id, name: record.name, pruned: true })
  }
  json(output)
}

async function cleanupCommand(
  store: RunStore,
  args: Array<string>,
  cliPath: string,
): Promise<void> {
  const reference = withoutOptions(args, [])[0]
  if (reference === undefined) throw new Error('Usage: wrkflw cleanup <run> [--force]')
  const record = await reconciledRecord(store, reference)
  if (!TERMINAL.has(record.status)) {
    throw new Error(`Run ${record.name} is still ${record.status}`)
  }
  const child = spawn(
    process.execPath,
    [cliPath, '_cleanup', record.id, ...(has(args, '--force') ? ['--force'] : [])],
    { cwd: process.cwd(), stdio: ['ignore', 'inherit', 'inherit'] },
  )
  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
  if (exitCode !== 0) process.exitCode = exitCode
}

async function cleanupWorker(store: RunStore, args: Array<string>): Promise<void> {
  const runId = args[0]
  if (runId === undefined) throw new Error('Missing cleanup run id')
  const stored = await store.get(runId)
  const record = reconcileRun(stored)
  if (!TERMINAL.has(record.status)) {
    throw new Error(`Run ${record.name} is still ${record.status}`)
  }
  if (record.status !== stored.status) {
    const finishedAt = new Date().toISOString()
    record.finishedAt = finishedAt
    for (const agent of Object.values(record.agents)) {
      if (agent.finishedAt === undefined && agent.status !== 'queued') {
        agent.finishedAt = finishedAt
      }
    }
    await store.event(runId, {
      type: record.status === 'crashed' ? 'workflow.crashed' : 'workflow.stopped',
      data: { error: record.error },
    })
    await store.update(runId, () => record)
  }
  const warnings = await cleanupRunWorkspaces(store, runId, has(args, '--force'))
  await store.releaseName(record.name, runId)
  json({ run: await store.get(runId), cleanupWarnings: warnings })
}

function usage(): string {
  return `wrkflw is an agent-first coding-agent workflow supervisor.

Commands:
  run <workflow.ts> <name> [--wait] [-- <workflow-args...>]
  list
  info <run> [--agent <agent-id>]
  transcript <run> [--agent <id>] [--kind <kind>] [--after <seq>] [--before <seq>] [--limit <n>] [--format json|text]
  search <run> <query> [--agent <id>] [--kind <kind>] [--limit <n>]
  search --all <query> [--agent <id>] [--kind <kind>] [--limit <n>]
  journal <run> [--agent <agent-id>] [--after <seq>] [--limit <n>]
  events <run> [--agent <agent-id>] [--after <seq>] [--limit <n>]
  follow <run> [--agent <agent-id>] [--detail summary|journal|raw]
  logs <run> [--stream stdout|stderr]
  stop <run>
  cleanup <run> [--force]
  history prune [run] [--older-than <age>] [--force]
  skill [${skillTopics.join('|')}]
`
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  const cliPath = fileURLToPath(import.meta.url)
  const store = new RunStore()

  switch (command) {
    case 'run':
      await runCommand(args, cliPath)
      return
    case 'list':
      json(await reconcileRuns(store))
      return
    case 'info':
    case 'status':
    case 'inspect': {
      const reference = args[0]
      if (reference === undefined) throw new Error('Usage: wrkflw info <run>')
      await info(store, reference, option(args, '--agent'))
      return
    }
    case 'transcript':
      await transcriptCommand(store, args)
      return
    case 'search':
      await searchCommand(store, args)
      return
    case 'journal':
      await journalCommand(store, args)
      return
    case 'events': {
      const reference = args[0]
      if (reference === undefined) throw new Error('Usage: wrkflw events <run>')
      const record = await store.resolve(reference)
      const filters = {
        agent: option(args, '--agent'),
        after: numberOption(args, '--after'),
      }
      let events = (await store.events(record.id)).filter((event) =>
        eventMatches(event, filters),
      )
      const limit = numberOption(args, '--limit', { minimum: 1 })
      if (limit !== undefined) events = events.slice(-limit)
      json(events)
      return
    }
    case 'follow': {
      const reference = args[0]
      if (reference === undefined) throw new Error('Usage: wrkflw follow <run>')
      await follow(
        store,
        reference,
        option(args, '--detail') ?? 'summary',
        option(args, '--agent'),
      )
      return
    }
    case 'logs': {
      const reference = args[0]
      if (reference === undefined) throw new Error('Usage: wrkflw logs <run>')
      const record = await store.resolve(reference)
      const stream = option(args, '--stream') ?? 'stderr'
      if (stream !== 'stdout' && stream !== 'stderr') {
        throw new Error('--stream must be stdout or stderr')
      }
      const content = await readFile(
        `${runDirectory(record.id)}/worker.${stream}.log`,
        'utf8',
      )
      process.stdout.write(content)
      return
    }
    case 'stop': {
      const reference = args[0]
      if (reference === undefined) throw new Error('Usage: wrkflw stop <run>')
      const record = await store.resolve(reference)
      json(await stopRun(record.id))
      return
    }
    case 'cleanup':
      await cleanupCommand(store, args, cliPath)
      return
    case 'history':
      await historyCommand(store, args)
      return
    case 'skill':
      process.stdout.write(`${renderSkill(args[0])}\n`)
      return
    case '_worker': {
      const runId = args[0]
      if (runId === undefined) throw new Error('Missing worker run id')
      await runWorker(runId)
      return
    }
    case '_cleanup':
      await cleanupWorker(store, args)
      return
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(usage())
      return
    default:
      throw new Error(`Unknown command ${command}\n\n${usage()}`)
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${JSON.stringify({ error: message })}\n`)
  process.exitCode = 1
})
