import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RunStore } from '../src/store.js'
import { reconcileRun } from '../src/supervisor.js'
import type { RunRecord } from '../src/types.js'

test('reconciles a running run whose worker disappeared', async () => {
  const previous = process.env.WRKFLW_STATE_DIR
  const state = await mkdtemp(join(tmpdir(), 'wrkflw-supervisor-'))
  process.env.WRKFLW_STATE_DIR = state
  try {
    const store = new RunStore()
    const record: RunRecord = {
      id: 'missing-worker',
      name: 'missing-worker',
      workflow: '/tmp/workflow.ts',
      cwd: '/tmp',
      args: [],
      pid: 2_147_483_647,
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      agents: {
        review: {
          id: 'review',
          model: 'gpt-5.6-luna',
          harness: 'codex',
          target: { kind: 'local' },
          cwd: '/tmp',
          status: 'queued',
          textChars: 0,
          eventCount: 0,
        },
      },
      warnings: [],
    }
    await store.create(record)

    const reconciled = reconcileRun(record)

    assert.equal(reconciled.status, 'crashed')
    assert.equal(reconciled.agents.review?.status, 'failed')
    assert.match(reconciled.error ?? '', /worker exited/)
    assert.equal((await store.get(record.id)).status, 'running')
  } finally {
    if (previous === undefined) delete process.env.WRKFLW_STATE_DIR
    else process.env.WRKFLW_STATE_DIR = previous
    await rm(state, { recursive: true, force: true })
  }
})
