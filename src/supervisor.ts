import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { RunStore, runDirectory } from './store.js'
import type { RunRecord } from './types.js'

const TERMINAL = new Set(['succeeded', 'failed', 'stopped'])
const QUEUED_WITHOUT_PID_GRACE_MS = 5_000

export function reconcileRun(record: RunRecord): RunRecord {
  if (TERMINAL.has(record.status)) return record
  const missingWorker =
    (record.pid !== undefined && !processIsAlive(record.pid)) ||
    (record.pid === undefined &&
      record.status === 'queued' &&
      Date.now() - Date.parse(record.createdAt) >= QUEUED_WITHOUT_PID_GRACE_MS)
  const stoppedWithoutWorker = record.status === 'stopping' && record.pid === undefined
  if (!missingWorker && !stoppedWithoutWorker) return record

  const stopped = record.status === 'stopping'
  const finishedAt = new Date().toISOString()
  const message = 'Workflow worker exited without recording a terminal state'
  const reconciled: RunRecord = {
    ...record,
    status: stopped ? 'stopped' : 'failed',
    finishedAt,
    agents: Object.fromEntries(
      Object.entries(record.agents).map(([id, agent]) => [id, { ...agent }]),
    ),
  }
  if (!stopped) reconciled.error = message
  for (const agent of Object.values(reconciled.agents)) {
    if (agent.status !== 'queued' && agent.status !== 'running') continue
    agent.status = stopped ? 'stopped' : 'failed'
    agent.finishedAt = finishedAt
    if (!stopped) agent.error = message
  }
  return reconciled
}

export async function reconcileRuns(
  store: RunStore,
  records?: Array<RunRecord>,
): Promise<Array<RunRecord>> {
  const candidates = records ?? (await store.list())
  return candidates.map(reconcileRun)
}

export async function startRun(options: {
  name: string
  workflow: string
  args: Array<string>
  cwd: string
  cliPath: string
}): Promise<RunRecord> {
  const store = new RunStore()
  const workflow = isAbsolute(options.workflow)
    ? options.workflow
    : resolve(options.cwd, options.workflow)
  await access(workflow)
  const id = store.newId()
  const record: RunRecord = {
    id,
    name: options.name,
    workflow,
    cwd: options.cwd,
    args: options.args,
    status: 'queued',
    createdAt: new Date().toISOString(),
    agents: {},
  }
  await store.create(record)

  const stdout = openSync(`${runDirectory(id)}/worker.stdout.log`, 'a')
  const stderr = openSync(`${runDirectory(id)}/worker.stderr.log`, 'a')
  const child = spawn(process.execPath, [options.cliPath, '_worker', id], {
    cwd: options.cwd,
    detached: true,
    env: process.env,
    stdio: ['ignore', stdout, stderr],
  })
  closeSync(stdout)
  closeSync(stderr)
  child.once('error', (error) => {
    void store.update(id, (current) => {
      if (current.status !== 'queued') return
      current.status = 'failed'
      current.finishedAt = new Date().toISOString()
      current.error = `Cannot start workflow worker: ${error.message}`
    })
  })
  child.unref()

  return child.pid === undefined ? record : { ...record, pid: child.pid }
}

export function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function stopRun(runId: string): Promise<RunRecord> {
  const store = new RunStore()
  const record = reconcileRun(await store.get(runId))
  if (record.status !== 'queued' && record.status !== 'running') return record
  const stopping: RunRecord = { ...record, status: 'stopping' }
  if (record.pid !== undefined) {
    try {
      process.kill(record.pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      return reconcileRun(stopping)
    }
  }
  return stopping
}
