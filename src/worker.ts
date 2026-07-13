import { tsImport } from 'tsx/esm/api'
import { RunStore } from './store.js'
import { WorkflowExecutor } from './executor.js'
import type { Workflow } from './types.js'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runWorker(runId: string): Promise<void> {
  const store = new RunStore()
  const record = await store.get(runId)
  const executor = new WorkflowExecutor(
    runId,
    record.name,
    record.cwd,
    record.args,
    store,
  )
  let stopping = false

  const stop = (): void => {
    stopping = true
    executor.abort()
    void store.update(runId, (current) => {
      if (current.status === 'running') current.status = 'stopping'
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  const startedAt = new Date().toISOString()
  await store.update(runId, (current) => {
    current.status = 'running'
    current.startedAt = startedAt
    current.pid = process.pid
  })
  await store.event(runId, {
    type: 'workflow.started',
    data: { workflow: record.workflow, pid: process.pid },
  })

  try {
    const module = (await tsImport(record.workflow, import.meta.url)) as {
      default?: unknown
    }
    if (typeof module.default !== 'function') {
      throw new Error('Workflow must export one default function')
    }
    const result = await (module.default as Workflow)(executor.context())
    const finishedAt = new Date().toISOString()
    await store.update(runId, (current) => {
      current.status = stopping ? 'stopped' : 'succeeded'
      current.finishedAt = finishedAt
    })
    await store.event(runId, {
      type: stopping ? 'workflow.stopped' : 'workflow.completed',
      data: { result },
    })
  } catch (error) {
    const finishedAt = new Date().toISOString()
    const message = messageOf(error)
    await store.update(runId, (current) => {
      current.status = stopping ? 'stopped' : 'failed'
      current.finishedAt = finishedAt
      current.error = message
    })
    await store.event(runId, {
      type: stopping ? 'workflow.stopped' : 'workflow.failed',
      data: { error: message },
    })
    if (!stopping) throw error
  }
}
