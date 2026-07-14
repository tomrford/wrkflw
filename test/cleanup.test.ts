import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cleanupRunWorkspaces } from '../src/cleanup.js'
import { RunStore } from '../src/store.js'
import type { ManagedWorkspace, RunRecord } from '../src/types.js'
import { createManagedWorkspace, pruneManagedWorkspace } from '../src/workspaces.js'

function initialiseGitRepository(root: string): void {
  execFileSync('git', ['init', '-b', 'main', root])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Wrkflw Test'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'wrkflw@example.test'])
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false'])
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'test: base'])
}

function runRecord(id: string, workspace: ManagedWorkspace): RunRecord {
  return {
    id,
    name: id,
    workflow: '/tmp/workflow.ts',
    cwd: workspace.sourceRoot,
    args: [],
    status: 'running',
    createdAt: '2026-07-14T00:00:00.000Z',
    agents: {
      review: {
        id: 'review',
        model: 'gpt-5.6-luna',
        harness: 'codex',
        target: workspace.target,
        cwd: workspace.path,
        workspace,
        status: 'succeeded',
        textChars: 1,
        eventCount: 1,
      },
    },
    warnings: [],
  }
}

test('automatic cleanup removes a clean managed workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrkflw-cleanup-git-'))
  const home = await mkdtemp(join(tmpdir(), 'wrkflw-cleanup-home-'))
  const state = await mkdtemp(join(tmpdir(), 'wrkflw-cleanup-state-'))
  const previousHome = process.env.WRKFLW_HOME
  const previousState = process.env.WRKFLW_STATE_DIR
  process.env.WRKFLW_HOME = home
  process.env.WRKFLW_STATE_DIR = state
  try {
    initialiseGitRepository(root)
    const resolution = await createManagedWorkspace({
      runId: 'clean-run',
      runName: 'clean-run',
      agentId: 'review',
      cwd: root,
    })
    assert.ok(resolution.workspace)
    const store = new RunStore()
    await store.create(runRecord('clean-run', resolution.workspace))

    const warnings = await cleanupRunWorkspaces(store, 'clean-run')

    assert.deepEqual(warnings, [])
    const record = await store.get('clean-run')
    assert.equal(record.agents.review?.workspace?.status, 'pruned')
    assert.equal(record.warnings.length, 0)
    assert.equal((await store.events('clean-run')).at(-1)?.type, 'workspace.cleanup')
  } finally {
    if (previousHome === undefined) delete process.env.WRKFLW_HOME
    else process.env.WRKFLW_HOME = previousHome
    if (previousState === undefined) delete process.env.WRKFLW_STATE_DIR
    else process.env.WRKFLW_STATE_DIR = previousState
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  }
})

test('automatic cleanup retains uncommitted work and archives a warning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrkflw-dirty-git-'))
  const home = await mkdtemp(join(tmpdir(), 'wrkflw-dirty-home-'))
  const state = await mkdtemp(join(tmpdir(), 'wrkflw-dirty-state-'))
  const previousHome = process.env.WRKFLW_HOME
  const previousState = process.env.WRKFLW_STATE_DIR
  process.env.WRKFLW_HOME = home
  process.env.WRKFLW_STATE_DIR = state
  let workspace: ManagedWorkspace | undefined
  try {
    initialiseGitRepository(root)
    const resolution = await createManagedWorkspace({
      runId: 'dirty-run',
      runName: 'dirty-run',
      agentId: 'review',
      cwd: root,
    })
    workspace = resolution.workspace
    assert.ok(workspace)
    await writeFile(join(resolution.cwd, 'uncommitted.txt'), 'keep me\n')
    const store = new RunStore()
    await store.create(runRecord('dirty-run', workspace))

    const warnings = await cleanupRunWorkspaces(store, 'dirty-run')

    assert.equal(warnings.length, 1)
    assert.equal(warnings[0]?.code, 'workspace-retained')
    const record = await store.get('dirty-run')
    assert.equal(record.agents.review?.workspace?.status, 'active')
    assert.equal(record.warnings.length, 1)
    assert.equal((await store.events('dirty-run')).at(-1)?.type, 'workflow.warning')

    await unlink(join(resolution.cwd, 'uncommitted.txt'))
    assert.deepEqual(await cleanupRunWorkspaces(store, 'dirty-run'), [])
    const cleaned = await store.get('dirty-run')
    assert.equal(cleaned.agents.review?.workspace?.status, 'pruned')
    assert.ok(cleaned.warnings[0]?.resolvedAt)
    assert.equal(
      (await store.events('dirty-run')).at(-1)?.type,
      'workflow.warning-resolved',
    )
  } finally {
    if (workspace !== undefined) await pruneManagedWorkspace(workspace, true)
    if (previousHome === undefined) delete process.env.WRKFLW_HOME
    else process.env.WRKFLW_HOME = previousHome
    if (previousState === undefined) delete process.env.WRKFLW_STATE_DIR
    else process.env.WRKFLW_STATE_DIR = previousState
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  }
})

test('cleanup retains an unmerged branch and resolves it after integration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrkflw-branch-git-'))
  const home = await mkdtemp(join(tmpdir(), 'wrkflw-branch-home-'))
  const state = await mkdtemp(join(tmpdir(), 'wrkflw-branch-state-'))
  const previousHome = process.env.WRKFLW_HOME
  const previousState = process.env.WRKFLW_STATE_DIR
  process.env.WRKFLW_HOME = home
  process.env.WRKFLW_STATE_DIR = state
  try {
    initialiseGitRepository(root)
    const resolution = await createManagedWorkspace({
      runId: 'branch-run',
      runName: 'branch-run',
      agentId: 'review',
      cwd: root,
    })
    const workspace = resolution.workspace
    assert.ok(workspace)
    assert.ok(workspace.branch)
    await writeFile(join(resolution.cwd, 'committed.txt'), 'keep me\n')
    execFileSync('git', ['-C', resolution.cwd, 'add', 'committed.txt'])
    execFileSync('git', ['-C', resolution.cwd, 'commit', '-m', 'test: agent work'])
    const store = new RunStore()
    const record = runRecord('branch-run', workspace)
    record.warnings.push({
      code: 'workspace-retained',
      message: 'Git worktree had uncommitted changes',
      at: '2026-07-14T00:00:01.000Z',
      agentId: 'review',
      target: workspace.target,
      path: workspace.path,
    })
    await store.create(record)

    const warnings = await cleanupRunWorkspaces(store, 'branch-run')

    assert.equal(warnings[0]?.code, 'git-branch-retained')
    assert.equal(
      (await store.get('branch-run')).agents.review?.workspace?.status,
      'retained',
    )
    const retained = await store.get('branch-run')
    assert.ok(retained.warnings[0]?.resolvedAt)
    assert.equal(retained.warnings[1]?.code, 'git-branch-retained')
    assert.equal(retained.warnings[1]?.resolvedAt, undefined)

    execFileSync('git', ['-C', root, 'merge', '--ff-only', workspace.branch])
    assert.deepEqual(await cleanupRunWorkspaces(store, 'branch-run'), [])
    const cleaned = await store.get('branch-run')
    assert.equal(cleaned.agents.review?.workspace?.status, 'pruned')
    assert.ok(cleaned.warnings[0]?.resolvedAt)
  } finally {
    if (previousHome === undefined) delete process.env.WRKFLW_HOME
    else process.env.WRKFLW_HOME = previousHome
    if (previousState === undefined) delete process.env.WRKFLW_STATE_DIR
    else process.env.WRKFLW_STATE_DIR = previousState
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  }
})
