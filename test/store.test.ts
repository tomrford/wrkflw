import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RunStore } from '../src/store.js'
import type { RunRecord } from '../src/types.js'

test('store persists run snapshots and ordered events', async () => {
  const previous = process.env.WRKFLW_STATE_DIR
  process.env.WRKFLW_STATE_DIR = await mkdtemp(join(tmpdir(), 'wrkflw-test-'))
  try {
    const store = new RunStore()
    const record: RunRecord = {
      id: 'run-one',
      name: 'one',
      workflow: '/tmp/workflow.ts',
      cwd: '/tmp',
      args: [],
      status: 'queued',
      createdAt: '2026-07-13T00:00:00.000Z',
      agents: {},
    }
    await store.create(record)
    await store.update(record.id, (current) => {
      current.status = 'running'
    })
    const first = await store.event(record.id, { type: 'workflow.started' })
    const second = await store.event(record.id, { type: 'workflow.completed' })
    const transcript = await store.transcript(record.id, {
      agentId: 'review',
      kind: 'assistant',
      content: 'A useful answer',
    })

    assert.equal((await store.get(record.id)).status, 'running')
    assert.equal((await store.resolve('one')).id, record.id)
    assert.deepEqual(
      (await store.events(record.id)).map((event) => event.seq),
      [1, 2],
    )
    assert.equal(first.seq, 1)
    assert.equal(second.seq, 2)
    assert.equal(transcript.seq, 1)
    assert.equal((await store.transcripts(record.id))[0]?.content, 'A useful answer')
  } finally {
    if (previous === undefined) delete process.env.WRKFLW_STATE_DIR
    else process.env.WRKFLW_STATE_DIR = previous
  }
})
