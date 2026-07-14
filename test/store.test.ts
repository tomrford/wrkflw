import assert from 'node:assert/strict'
import { access, appendFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RunStore, runDirectory } from '../src/store.js'
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
      status: 'running',
      createdAt: '2026-07-13T00:00:00.000Z',
      agents: {},
      warnings: [],
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
    assert.equal(transcript.seq, 3)
    assert.equal((await store.transcripts(record.id))[0]?.content, 'A useful answer')
    assert.deepEqual(
      (await store.journal(record.id)).map((entry) => entry.channel),
      ['event', 'event', 'transcript'],
    )
    await access(join(process.env.WRKFLW_STATE_DIR, 'runs', record.id, 'summary.json'))
    await access(
      join(process.env.WRKFLW_STATE_DIR, 'runs', record.id, 'journal.ndjson'),
    )

    const complete = await store.journalChunk(record.id)
    await appendFile(
      join(runDirectory(record.id), 'journal.ndjson'),
      '{"channel":"event","seq":4',
    )
    assert.equal((await store.journal(record.id)).length, 3)
    assert.deepEqual(await store.journalChunk(record.id, complete.nextOffset), {
      entries: [],
      nextOffset: complete.nextOffset,
    })
    await appendFile(
      join(runDirectory(record.id), 'journal.ndjson'),
      ',"at":"2026-07-13T00:00:01.000Z","runId":"run-one","type":"late"}\n',
    )
    const tail = await store.journalChunk(record.id, complete.nextOffset)
    assert.equal(tail.entries[0]?.seq, 4)
    assert.ok(tail.nextOffset > complete.nextOffset)

    const reservation = {
      id: record.id,
      createdAt: '2026-07-13T00:00:00.000Z',
    }
    assert.equal(await store.reserveName(record.name, reservation), true)
    assert.equal(await store.reserveName(record.name, reservation), false)
    assert.deepEqual(await store.nameReservation(record.name), reservation)
    assert.equal(await store.releaseName(record.name, 'another-run'), false)
    assert.equal(await store.releaseName(record.name, record.id), true)
    assert.equal(await store.reserveName(record.name, reservation), true)
    await store.releaseName(record.name, record.id)
    const claims = await Promise.all([
      store.reserveName('simultaneous', { ...reservation, id: 'first' }),
      store.reserveName('simultaneous', { ...reservation, id: 'second' }),
    ])
    assert.deepEqual(claims.sort(), [false, true])
    const owner = await store.nameReservation('simultaneous')
    assert.ok(owner)
    await store.releaseName('simultaneous', owner.id)
  } finally {
    if (previous === undefined) delete process.env.WRKFLW_STATE_DIR
    else process.env.WRKFLW_STATE_DIR = previous
  }
})
