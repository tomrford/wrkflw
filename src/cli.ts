#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { renderSkill, skillTopics } from './skill.js'
import { RunStore, runDirectory } from './store.js'
import { reconcileRun, reconcileRuns, startRun, stopRun } from './supervisor.js'
import { TRANSCRIPT_KINDS } from './types.js'
import { runWorker } from './worker.js'
import { pruneManagedWorkspace } from './workspaces.js'
import type { RunEvent, RunRecord, TranscriptEntry, TranscriptKind } from './types.js'

const TERMINAL = new Set(['succeeded', 'failed', 'stopped'])

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
  if (!['summary', 'events', 'raw'].includes(detail)) {
    throw new Error('--detail must be summary, events or raw')
  }
  const initial = await store.resolve(reference)
  let cursor = 0
  while (true) {
    const events = await store.events(initial.id)
    for (const event of events) {
      if (!eventMatches(event, { agent, after: cursor })) continue
      if (detail === 'summary' && event.type === 'agent.event') continue
      if (detail === 'raw' && event.type === 'agent.event') jsonLine(event.data)
      else jsonLine(event)
    }
    cursor = Math.max(cursor, events.at(-1)?.seq ?? 0)
    const record = await reconciledRecord(store, initial.id)
    if (TERMINAL.has(record.status) && cursor >= (events.at(-1)?.seq ?? 0)) return
    await sleep(250)
  }
}

async function info(
  store: RunStore,
  reference: string,
  agentId: string | undefined,
): Promise<void> {
  const record = await reconciledRecord(store, reference)
  const transcript = await store.transcripts(record.id)
  if (agentId === undefined) {
    json({ ...record, transcriptEntries: transcript.length })
    return
  }
  const state = record.agents[agentId]
  if (state === undefined) throw new Error(`Run ${record.name} has no agent ${agentId}`)
  const completed = (await store.events(record.id))
    .filter((event) => event.agentId === agentId && event.type === 'agent.completed')
    .at(-1)
  json({
    runId: record.id,
    runName: record.name,
    ...state,
    transcriptEntries: transcript.filter((entry) => entry.agentId === agentId).length,
    ...(completed === undefined ? {} : { result: completed.data }),
  })
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
  const record = await startRun({
    name,
    workflow,
    args: workflowArgs,
    cwd: process.cwd(),
    cliPath,
  })
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

async function pruneCommand(store: RunStore, args: Array<string>): Promise<void> {
  const reference = withoutOptions(args, [])[0]
  const records =
    reference === undefined
      ? await reconcileRuns(store)
      : await reconcileRuns(store, [await store.resolve(reference)])
  const force = has(args, '--force')
  const output: Array<Record<string, unknown>> = []
  for (const record of records) {
    if (!TERMINAL.has(record.status)) {
      output.push({
        runId: record.id,
        name: record.name,
        pruned: false,
        reason: 'run is active',
      })
      continue
    }
    for (const agent of Object.values(record.agents)) {
      if (agent.workspace === undefined || agent.workspace.status === 'pruned') continue
      let result: Awaited<ReturnType<typeof pruneManagedWorkspace>>
      try {
        result = await pruneManagedWorkspace(agent.workspace, force)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        output.push({
          runId: record.id,
          name: record.name,
          agentId: agent.id,
          path: agent.workspace.path,
          pruned: false,
          reason,
        })
        process.exitCode = 1
        continue
      }
      output.push({ runId: record.id, name: record.name, agentId: agent.id, ...result })
      if (result.pruned) {
        await store.update(record.id, (current) => {
          const workspace = current.agents[agent.id]?.workspace
          if (workspace === undefined) return
          workspace.status = 'pruned'
          workspace.prunedAt = new Date().toISOString()
          if (result.bookmark !== undefined) workspace.bookmark = result.bookmark
          if (result.finalRevision !== undefined) {
            workspace.finalRevision = result.finalRevision
          }
        })
      }
    }
  }
  json(output)
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
  events <run> [--agent <agent-id>] [--after <seq>] [--limit <n>]
  follow <run> [--agent <agent-id>] [--detail summary|events|raw]
  logs <run> [--stream stdout|stderr]
  stop <run>
  prune [run] [--force]
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
    case 'prune':
      await pruneCommand(store, args)
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
