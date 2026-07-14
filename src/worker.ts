import { tsImport } from 'tsx/esm/api'
import { cleanupRunWorkspaces } from './cleanup.js'
import { RunStore } from './store.js'
import { WorkflowExecutor } from './executor.js'
import type { RunBootstrap, RunRecord, RunStatus, Workflow } from './types.js'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function workflowFrom(module: { default?: unknown }): Workflow {
  if (typeof module.default === 'function') return module.default as Workflow
  if (
    module.default !== null &&
    typeof module.default === 'object' &&
    'default' in module.default &&
    typeof module.default.default === 'function'
  ) {
    return module.default.default as Workflow
  }
  throw new Error('Workflow must export one default function')
}

export async function runWorker(runId: string): Promise<void> {
  const encoded = process.env.WRKFLW_RUN_BOOTSTRAP
  delete process.env.WRKFLW_RUN_BOOTSTRAP
  if (encoded === undefined) throw new Error('Missing workflow bootstrap data')
  const bootstrap = JSON.parse(encoded) as RunBootstrap
  if (bootstrap.id !== runId) throw new Error('Workflow bootstrap run ID mismatch')

  const store = new RunStore()
  const startedAt = new Date().toISOString()
  const record: RunRecord = {
    ...bootstrap,
    pid: process.pid,
    status: 'running',
    startedAt,
    agents: {},
    warnings: [],
  }
  await store.create(record)
  const executor = new WorkflowExecutor(
    runId,
    record.name,
    record.cwd,
    record.args,
    store,
  )
  let stopping = false

  const stop = (): void => {
    if (stopping) return
    stopping = true
    executor.abort()
    void store.update(runId, (current) => {
      if (current.status === 'running') current.status = 'stopping'
    })
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  await store.event(runId, {
    type: 'workflow.started',
    data: { workflow: record.workflow, pid: process.pid },
  })

  let terminalStatus: Extract<RunStatus, 'succeeded' | 'failed' | 'stopped'>
  let terminalEvent: 'workflow.completed' | 'workflow.failed' | 'workflow.stopped'
  let terminalData: unknown
  let terminalError: string | undefined
  let unhandled: unknown
  let shouldRethrow = false
  try {
    const module = (await tsImport(record.workflow, import.meta.url)) as {
      default?: unknown
    }
    const result = await workflowFrom(module)(executor.context())
    terminalStatus = stopping ? 'stopped' : 'succeeded'
    terminalEvent = stopping ? 'workflow.stopped' : 'workflow.completed'
    terminalData = { result }
  } catch (error) {
    const message = messageOf(error)
    terminalStatus = stopping ? 'stopped' : 'failed'
    terminalEvent = stopping ? 'workflow.stopped' : 'workflow.failed'
    terminalData = { error: message }
    if (!stopping) {
      terminalError = message
      unhandled = error
      shouldRethrow = true
    }
  }

  try {
    await cleanupRunWorkspaces(store, runId)
  } catch (error) {
    const message = messageOf(error)
    process.stderr.write(`Workspace cleanup failed: ${message}\n`)
    const warning = {
      code: 'run-cleanup-failed',
      message,
      at: new Date().toISOString(),
    }
    try {
      await store.event(runId, { type: 'workspace.cleanup-failed', data: warning })
      await store.update(runId, (current) => {
        current.warnings.push(warning)
      })
    } catch (archiveError) {
      process.stderr.write(
        `Cannot archive workspace cleanup failure: ${messageOf(archiveError)}\n`,
      )
    }
  }
  await store.event(runId, { type: terminalEvent, data: terminalData })
  const finishedAt = new Date().toISOString()
  await store.update(runId, (current) => {
    current.status = terminalStatus
    current.finishedAt = finishedAt
    if (terminalError !== undefined) current.error = terminalError
  })
  try {
    await store.releaseName(record.name, runId)
  } catch (error) {
    process.stderr.write(`Cannot release run name: ${messageOf(error)}\n`)
  }
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  if (shouldRethrow) throw unhandled
}
