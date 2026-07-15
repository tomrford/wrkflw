import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RunStore } from '../src/store.js'
import type { RunRecord } from '../src/types.js'

const execute = promisify(execFile)

test('follow raw emits native SDK events without a Wrkflw envelope', async () => {
  const state = await mkdtemp(join(tmpdir(), 'wrkflw-cli-test-'))
  const previous = process.env.WRKFLW_STATE_DIR
  process.env.WRKFLW_STATE_DIR = state
  try {
    const record: RunRecord = {
      id: 'raw-run',
      name: 'raw-run',
      workflow: '/tmp/workflow.ts',
      cwd: '/tmp',
      args: [],
      status: 'succeeded',
      createdAt: '2026-07-15T00:00:00.000Z',
      finishedAt: '2026-07-15T00:00:01.000Z',
      agents: {},
      warnings: [],
    }
    const store = new RunStore()
    await store.create(record)
    await store.event(record.id, {
      type: 'agent.event',
      agentId: 'review',
      data: { type: 'thread.started', thread_id: 'native-session' },
    })

    const { stdout } = await execute(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'follow', record.id, '--detail', 'raw'],
      {
        cwd: process.cwd(),
        env: { ...process.env, WRKFLW_STATE_DIR: state },
      },
    )
    assert.deepEqual(JSON.parse(stdout.trim()), {
      type: 'thread.started',
      thread_id: 'native-session',
    })
  } finally {
    if (previous === undefined) delete process.env.WRKFLW_STATE_DIR
    else process.env.WRKFLW_STATE_DIR = previous
  }
})
