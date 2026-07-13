import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkflowExecutor } from '../src/executor.js'
import { RunStore } from '../src/store.js'

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
