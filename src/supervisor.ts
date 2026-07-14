import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { RunStore, runDirectory } from './store.js'
import type { RunBootstrap, RunRecord } from './types.js'

const TERMINAL = new Set(['succeeded', 'failed', 'crashed', 'stopped'])
const WORKER_START_TIMEOUT_MS = 30_000

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
}

async function waitForProcessExit(
  pid: number | undefined,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds
  while (processIsAlive(pid) && Date.now() < deadline) await sleep(50)
  return !processIsAlive(pid)
}

export function reconcileRun(record: RunRecord): RunRecord {
  if (TERMINAL.has(record.status)) return record
  const missingWorker = !processIsAlive(record.pid)
  const stoppedWithoutWorker = record.status === 'stopping' && record.pid === undefined
  if (!missingWorker && !stoppedWithoutWorker) return record

  const stopped = record.status === 'stopping'
  const message = 'Workflow worker exited without recording a terminal state'
  const reconciled: RunRecord = {
    ...record,
    status: stopped ? 'stopped' : 'crashed',
    agents: Object.fromEntries(
      Object.entries(record.agents).map(([id, agent]) => [id, { ...agent }]),
    ),
  }
  if (!stopped) reconciled.error = message
  for (const agent of Object.values(reconciled.agents)) {
    if (agent.status !== 'queued' && agent.status !== 'running') continue
    agent.status = stopped ? 'stopped' : 'failed'
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
  id: string
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
  const id = options.id
  const bootstrap: RunBootstrap = {
    id,
    name: options.name,
    workflow,
    cwd: options.cwd,
    args: options.args,
    createdAt: new Date().toISOString(),
  }
  await store.prepare(id)

  const stdout = openSync(`${runDirectory(id)}/worker.stdout.log`, 'a')
  const stderr = openSync(`${runDirectory(id)}/worker.stderr.log`, 'a')
  const child = spawn(process.execPath, [options.cliPath, '_worker', id], {
    cwd: options.cwd,
    detached: true,
    env: {
      ...process.env,
      WRKFLW_RUN_BOOTSTRAP: JSON.stringify(bootstrap),
    },
    stdio: ['ignore', stdout, stderr],
  })
  closeSync(stdout)
  closeSync(stderr)
  try {
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn)
      child.once('error', rejectSpawn)
    })
  } catch (error) {
    await store.remove(id)
    throw error
  }
  child.unref()

  const deadline = Date.now() + WORKER_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      return await store.get(id)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!processIsAlive(child.pid)) {
        const stderr = await readFile(`${runDirectory(id)}/worker.stderr.log`, 'utf8')
        await store.remove(id)
        const detail = stderr.trim()
        throw new Error(
          `Workflow worker exited before creating archive ${id}${detail ? `: ${detail}` : ''}`,
        )
      }
      await sleep(50)
    }
  }
  if (child.pid !== undefined) {
    try {
      process.kill(child.pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  if (!(await waitForProcessExit(child.pid, 5_000)) && child.pid !== undefined) {
    try {
      process.kill(child.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    await waitForProcessExit(child.pid, 5_000)
  }
  if (processIsAlive(child.pid)) {
    throw new Error(`Timed out waiting for workflow worker ${id} to stop`)
  }
  await store.remove(id)
  throw new Error(`Timed out waiting for workflow worker ${id}`)
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
  if (record.status !== 'running') return record
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
