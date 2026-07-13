import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createManagedWorkspace, pruneManagedWorkspace } from '../src/workspaces.js'

function commandExists(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('creates 3 independent Git worktrees and prunes them safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrkflw-git-'))
  const home = await mkdtemp(join(tmpdir(), 'wrkflw-home-'))
  const previous = process.env.WRKFLW_HOME
  process.env.WRKFLW_HOME = home
  try {
    execFileSync('git', ['init', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Wrkflw Test'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'wrkflw@example.test'])
    execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false'])
    await writeFile(join(root, 'tracked.txt'), 'base\n')
    execFileSync('git', ['-C', root, 'add', 'tracked.txt'])
    execFileSync('git', ['-C', root, 'commit', '-m', 'test: base'])

    const resolutions = await Promise.all(
      ['review-one', 'review-two', 'review-three'].map((agentId) =>
        createManagedWorkspace({
          runId: '12345678-0000-0000-0000-000000000000',
          runName: 'three-reviews',
          agentId,
          cwd: root,
        }),
      ),
    )
    assert.equal(new Set(resolutions.map((resolution) => resolution.cwd)).size, 3)
    const workspaces = resolutions.map((resolution) => resolution.workspace)
    assert.ok(workspaces.every((workspace) => workspace !== undefined))
    const [first, second, third] = workspaces
    assert.ok(first)
    assert.ok(second)
    assert.ok(third)
    assert.equal(first.kind, 'git-worktree')
    assert.match(resolutions[0]?.cwd ?? '', /\.wrkflw|wrkflw-home-/)

    await writeFile(join(resolutions[0]?.cwd ?? '', 'tracked.txt'), 'changed\n')
    const safe = await pruneManagedWorkspace(first)
    assert.equal(safe.pruned, false)
    assert.match(safe.reason ?? '', /uncommitted changes/)

    const clean = await Promise.all([
      pruneManagedWorkspace(second),
      pruneManagedWorkspace(third),
    ])
    assert.ok(clean.every((result) => result.pruned))
    assert.equal((await pruneManagedWorkspace(first, true)).pruned, true)
  } finally {
    if (previous === undefined) delete process.env.WRKFLW_HOME
    else process.env.WRKFLW_HOME = previous
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('creates and prunes a Git worktree through SSH', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'wrkflw-ssh-'))
  const root = join(parent, 'repo')
  const remoteHome = join(parent, 'home')
  const bin = join(parent, 'bin')
  const previousHome = process.env.HOME
  const previousPath = process.env.PATH
  const previousWrkflwHome = process.env.WRKFLW_HOME
  try {
    await mkdir(bin, { recursive: true })
    const fakeSsh = join(bin, 'ssh')
    await writeFile(
      fakeSsh,
      `#!/bin/sh
if [ "$1" = "-o" ]; then
  shift 2
fi
shift
exec sh -c "$1"
`,
    )
    await chmod(fakeSsh, 0o755)
    process.env.HOME = remoteHome
    process.env.PATH = `${bin}:${previousPath ?? ''}`
    process.env.WRKFLW_HOME = join(remoteHome, '.wrkflw')

    execFileSync('git', ['init', '-b', 'main', root])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Wrkflw Test'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'wrkflw@example.test'])
    execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false'])
    execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'test: base'])

    const resolution = await createManagedWorkspace({
      runId: 'remote12-0000-0000-0000-000000000000',
      runName: 'remote-test',
      agentId: 'review',
      cwd: root,
      target: { kind: 'ssh', host: 'test-host' },
    })
    const workspace = resolution.workspace
    assert.ok(workspace)
    assert.equal(workspace.target.kind, 'ssh')
    assert.match(workspace.path, /home\/.wrkflw\/worktrees/)
    assert.equal((await pruneManagedWorkspace(workspace)).pruned, true)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousWrkflwHome === undefined) delete process.env.WRKFLW_HOME
    else process.env.WRKFLW_HOME = previousWrkflwHome
    await rm(parent, { recursive: true, force: true })
  }
})

test('bookmarks a changed jj workspace before pruning', {
  skip: !commandExists('jj'),
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'wrkflw-jj-'))
  const root = join(parent, 'repo')
  const home = await mkdtemp(join(tmpdir(), 'wrkflw-home-'))
  const previous = process.env.WRKFLW_HOME
  process.env.WRKFLW_HOME = home
  try {
    execFileSync('jj', ['--config', 'signing.behavior="drop"', 'git', 'init', root])
    const resolution = await createManagedWorkspace({
      runId: '87654321-0000-0000-0000-000000000000',
      runName: 'three-reviews',
      agentId: 'review-two',
      cwd: root,
    })
    const workspace = resolution.workspace
    assert.ok(workspace)
    assert.equal(workspace.kind, 'jj-workspace')
    await writeFile(join(resolution.cwd, 'review.txt'), 'preserve me\n')
    const pruned = await pruneManagedWorkspace(workspace)
    assert.equal(pruned.pruned, true)
    assert.match(pruned.bookmark ?? '', /^wrkflw\//)
    const preserved = execFileSync(
      'jj',
      [
        '--repository',
        root,
        'log',
        '--no-graph',
        '-r',
        pruned.bookmark ?? '',
        '-T',
        'commit_id',
      ],
      { encoding: 'utf8' },
    ).trim()
    assert.equal(preserved, pruned.finalRevision)
  } finally {
    if (previous === undefined) delete process.env.WRKFLW_HOME
    else process.env.WRKFLW_HOME = previous
    await rm(parent, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('does not retain a bookmark for an unchanged jj workspace', {
  skip: !commandExists('jj'),
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'wrkflw-jj-clean-'))
  const root = join(parent, 'repo')
  const home = await mkdtemp(join(tmpdir(), 'wrkflw-home-'))
  const previous = process.env.WRKFLW_HOME
  process.env.WRKFLW_HOME = home
  try {
    execFileSync('jj', ['--config', 'signing.behavior="drop"', 'git', 'init', root])
    const resolution = await createManagedWorkspace({
      runId: '11223344-0000-0000-0000-000000000000',
      runName: 'clean-review',
      agentId: 'review',
      cwd: root,
    })
    const workspace = resolution.workspace
    assert.ok(workspace)
    assert.equal(workspace.kind, 'jj-workspace')

    const pruned = await pruneManagedWorkspace(workspace)

    assert.equal(pruned.pruned, true)
    assert.equal(pruned.bookmark, undefined)
    assert.equal(pruned.finalRevision, workspace.baseRevision)
    const bookmarks = execFileSync(
      'jj',
      ['--repository', root, 'bookmark', 'list', '--all'],
      { encoding: 'utf8' },
    )
    assert.doesNotMatch(bookmarks, /wrkflw\//)
  } finally {
    if (previous === undefined) delete process.env.WRKFLW_HOME
    else process.env.WRKFLW_HOME = previous
    await rm(parent, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('rejects worktree creation outside a repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wrkflw-plain-'))
  try {
    await assert.rejects(
      createManagedWorkspace({
        runId: 'plain',
        runName: 'plain',
        agentId: 'review',
        cwd: directory,
      }),
      /requires cwd inside a native Git or jj working copy/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
