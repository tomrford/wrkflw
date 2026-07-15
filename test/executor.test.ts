import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { z } from 'zod'
import { WorkflowExecutor } from '../src/executor.js'
import { RunStore } from '../src/store.js'
import type { HarnessDriverFactory } from '../src/harnesses.js'
import type { RunRecord } from '../src/types.js'

async function executorWithDriver(driverFactory: HarnessDriverFactory) {
  const root = await mkdtemp(join(tmpdir(), 'wrkflw-executor-test-'))
  const previous = process.env.WRKFLW_STATE_DIR
  process.env.WRKFLW_STATE_DIR = root
  const store = new RunStore()
  const record: RunRecord = {
    id: 'run',
    name: 'driver-test',
    workflow: '/tmp/workflow.ts',
    cwd: root,
    args: [],
    status: 'running',
    createdAt: '2026-07-15T00:00:00.000Z',
    agents: {},
    warnings: [],
  }
  await store.create(record)
  return {
    root,
    store,
    executor: new WorkflowExecutor(
      record.id,
      record.name,
      root,
      [],
      store,
      driverFactory,
    ),
    restore() {
      if (previous === undefined) delete process.env.WRKFLW_STATE_DIR
      else process.env.WRKFLW_STATE_DIR = previous
    },
  }
}

test('parallel waits for siblings before reporting failures', async () => {
  const executor = new WorkflowExecutor(
    'run',
    'parallel-test',
    process.cwd(),
    [],
    new RunStore(),
  )
  let siblingFinished = false
  const rejected = Promise.reject(new Error('first failed'))
  const sibling = new Promise<string>((resolve) => {
    setTimeout(() => {
      siblingFinished = true
      resolve('finished')
    }, 20)
  })

  await assert.rejects(
    executor.context().parallel([rejected, sibling]),
    /1 parallel operation failed/,
  )
  assert.equal(siblingFinished, true)
})

test('settle returns every individual outcome', async () => {
  const executor = new WorkflowExecutor(
    'run',
    'settle-test',
    process.cwd(),
    [],
    new RunStore(),
  )
  const results = await executor
    .context()
    .settle([Promise.resolve('ok'), Promise.reject(new Error('failed'))])

  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
})

test('rejects a session resumed through a different harness', async () => {
  const executor = new WorkflowExecutor(
    'run',
    'resume-test',
    process.cwd(),
    [],
    new RunStore(),
  )

  await assert.rejects(
    executor.context().run({
      id: 'review',
      harness: 'codex',
      model: 'gpt-5.6-luna',
      prompt: 'Continue.',
      resume: {
        id: 'claude-session',
        harness: 'claude-code',
        location: { target: { kind: 'local' }, cwd: process.cwd() },
      },
    }),
    /cannot resume a claude-code session with codex/,
  )
})

test('validates, types and archives structured output from a native driver', async () => {
  let receivedModel = ''
  const fixture = await executorWithDriver((options) => ({
    async run(sink) {
      receivedModel = options.model
      await sink.event({ type: 'native.started' })
      await sink.transcript({
        kind: 'assistant',
        content: '{"answer":"OK"}',
        messageId: 'message',
      })
      return {
        text: '{"answer":"OK"}',
        sessionId: 'session',
        structuredOutput: { answer: 'OK' },
      }
    },
  }))
  try {
    const result = await fixture.executor.context().run({
      id: 'structured',
      harness: 'codex',
      model: 'gpt-5.6-luna',
      prompt: 'Return an answer.',
      outputSchema: z.object({ answer: z.string() }),
    })
    const typedAnswer: string = result.output.answer
    assert.equal(typedAnswer, 'OK')
    assert.equal(receivedModel, 'gpt-5.6-luna')
    assert.deepEqual((await fixture.store.get('run')).agents.structured?.output, {
      answer: 'OK',
    })
    const native = (await fixture.store.events('run')).find(
      (event) => event.type === 'agent.event',
    )
    assert.deepEqual(native?.data, { type: 'native.started' })
  } finally {
    fixture.restore()
  }
})

test('rejects relative SSH directories before starting either harness', async () => {
  for (const harness of ['claude-code', 'codex'] as const) {
    const executor = new WorkflowExecutor(
      'run',
      'ssh-path-test',
      process.cwd(),
      [],
      new RunStore(),
    )
    await assert.rejects(
      executor.context().run({
        id: harness,
        harness,
        model: harness === 'claude-code' ? 'claude-haiku-4-5' : 'gpt-5.6-luna',
        prompt: 'Review.',
        location: {
          target: { kind: 'ssh', host: 'mini' },
          cwd: 'relative/repo',
        },
      }),
      /needs an absolute cwd for an SSH location/,
    )
  }
})

test('rejects structured output that fails local schema validation', async () => {
  const fixture = await executorWithDriver(() => ({
    async run() {
      return { text: '{"answer":42}', structuredOutput: { answer: 42 } }
    },
  }))
  try {
    await assert.rejects(
      fixture.executor.context().run({
        id: 'invalid',
        harness: 'claude-code',
        model: 'claude-haiku-4-5',
        prompt: 'Return an answer.',
        outputSchema: z.object({ answer: z.string() }),
      }),
      /\$\.answer: Invalid input: expected string, received number/,
    )
  } finally {
    fixture.restore()
  }
})
