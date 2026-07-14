import { createHash } from 'node:crypto'
import { mkdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, relative, resolve } from 'node:path'
import { assertCommandSuccess, executeTarget } from './target-command.js'
import type { ManagedWorkspace, Target } from './types.js'

interface Repository {
  kind: 'git' | 'jj'
  root: string
}

export interface WorkspaceInspection {
  cwd: string
  repository?: Repository
}

export interface WorkspaceResolution {
  cwd: string
  workspace?: ManagedWorkspace
}

export interface PruneResult {
  path: string
  pruned: boolean
  reason?: string
  branch?: string
  branchRetained?: boolean
  bookmark?: string
  finalRevision?: string
}

export function wrkflwHome(): string {
  return process.env.WRKFLW_HOME ?? join(homedir(), '.wrkflw')
}

export function managedWorkspaceRoot(): string {
  return join(wrkflwHome(), 'worktrees')
}

function safeName(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (safe || 'run').slice(0, 64)
}

function repoKey(root: string): string {
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 10)
  return `${safeName(basename(root))}-${digest}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function canonicalCwd(cwd: string, target: Target): Promise<string> {
  if (target.kind === 'local') return realpath(resolve(cwd))
  if (!posix.isAbsolute(cwd)) throw new Error(`SSH target cwd must be absolute: ${cwd}`)
  const result = await executeTarget('pwd', ['-P'], cwd, target)
  assertCommandSuccess(result, `Cannot resolve ${target.host}:${cwd}`)
  return result.stdout.trim()
}

async function targetExists(path: string, target: Target): Promise<boolean> {
  if (target.kind === 'local') return exists(path)
  return (await executeTarget('test', ['-e', path], undefined, target)).exitCode === 0
}

async function makeDirectory(path: string, target: Target): Promise<void> {
  if (target.kind === 'local') {
    await mkdir(path, { recursive: true })
    return
  }
  const result = await executeTarget('mkdir', ['-p', '--', path], undefined, target)
  assertCommandSuccess(result, `Cannot create ${target.host}:${path}`)
}

async function removeDirectory(path: string, target: Target): Promise<void> {
  if (target.kind === 'local') {
    await rm(path, { recursive: true, force: true })
    return
  }
  const result = await executeTarget('rm', ['-rf', '--', path], undefined, target)
  assertCommandSuccess(result, `Cannot remove ${target.host}:${path}`)
}

async function targetManagedWorkspaceRoot(target: Target): Promise<string> {
  if (target.kind === 'local') return managedWorkspaceRoot()
  const root = await executeTarget(
    'sh',
    [
      '-c',
      `if [ -n "\${WRKFLW_HOME:-}" ]; then printf "%s\\n" "$WRKFLW_HOME/worktrees"; else printf "%s\\n" "$HOME/.wrkflw/worktrees"; fi`,
    ],
    undefined,
    target,
  )
  assertCommandSuccess(root, `Cannot resolve managed workspace root on ${target.host}`)
  return root.stdout.trim()
}

async function findAncestor(
  start: string,
  marker: string,
  target: Target,
): Promise<string | null> {
  let current = target.kind === 'local' ? resolve(start) : posix.resolve(start)
  while (true) {
    const path =
      target.kind === 'local' ? join(current, marker) : posix.join(current, marker)
    if (await targetExists(path, target)) return current
    const parent = target.kind === 'local' ? dirname(current) : posix.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function detectRepository(
  cwd: string,
  target: Target,
): Promise<Repository | null> {
  const jj = await executeTarget('jj', ['root'], cwd, target)
  if (jj.exitCode === 0) return { kind: 'jj', root: jj.stdout.trim() }

  const jjMarker = await findAncestor(cwd, '.jj', target)
  if (jjMarker !== null) {
    throw new Error(
      `Cannot manage ${jjMarker}: it has .jj metadata but the native jj CLI cannot open it`,
    )
  }

  const git = await executeTarget(
    'git',
    ['-C', cwd, 'rev-parse', '--show-toplevel'],
    undefined,
    target,
  )
  if (git.exitCode === 0) return { kind: 'git', root: git.stdout.trim() }
  return null
}

export async function inspectWorkspaceLocation(input: {
  cwd: string
  target: Target
  requireRepository: boolean
}): Promise<WorkspaceInspection> {
  const cwd = await canonicalCwd(input.cwd, input.target)
  if (!input.requireRepository) return { cwd }
  const repository = await detectRepository(cwd, input.target)
  if (repository === null) {
    throw new Error(
      `worktree: true requires cwd inside a native Git or jj working copy: ${cwd}`,
    )
  }
  return { cwd, repository }
}

function workspacePath(
  target: Target,
  managedRoot: string,
  repositoryRoot: string,
  runName: string,
  runId: string,
  agentId: string,
): string {
  const pathApi = target.kind === 'local' ? { join } : posix
  return pathApi.join(
    managedRoot,
    repoKey(repositoryRoot),
    `${safeName(runName)}-${runId.slice(0, 8)}`,
    safeName(agentId),
  )
}

export async function createManagedWorkspace(input: {
  runId: string
  runName: string
  agentId: string
  cwd: string
  revision?: string
  target?: Target
}): Promise<WorkspaceResolution> {
  const target = input.target ?? { kind: 'local' }
  const sourceCwd = await canonicalCwd(input.cwd, target)
  const repository = await detectRepository(sourceCwd, target)
  if (repository === null) {
    throw new Error(
      `worktree: true requires cwd inside a native Git or jj working copy: ${sourceCwd}`,
    )
  }

  const subdirectory =
    target.kind === 'local'
      ? relative(repository.root, sourceCwd)
      : posix.relative(repository.root, sourceCwd)
  if (subdirectory.startsWith('..')) {
    throw new Error(`${sourceCwd} is outside repository root ${repository.root}`)
  }

  const managedRoot = await targetManagedWorkspaceRoot(target)
  const path = workspacePath(
    target,
    managedRoot,
    repository.root,
    input.runName,
    input.runId,
    input.agentId,
  )
  await makeDirectory(
    target.kind === 'local' ? dirname(path) : posix.dirname(path),
    target,
  )
  const createdAt = new Date().toISOString()

  if (repository.kind === 'git') {
    const branch = `wrkflw/${safeName(input.runName)}-${input.runId.slice(0, 8)}/${safeName(input.agentId)}`
    const revision = input.revision ?? 'HEAD'
    const add = await executeTarget(
      'git',
      [
        '-C',
        repository.root,
        'worktree',
        'add',
        '--lock',
        '--reason',
        `wrkflw:${input.runId}:${input.agentId}`,
        '-b',
        branch,
        path,
        revision,
      ],
      undefined,
      target,
    )
    assertCommandSuccess(add, `Cannot create Git worktree for ${input.agentId}`)
    const head = await executeTarget(
      'git',
      ['-C', path, 'rev-parse', 'HEAD'],
      undefined,
      target,
    )
    assertCommandSuccess(head, `Cannot read Git worktree revision for ${input.agentId}`)
    const workspace: ManagedWorkspace = {
      kind: 'git-worktree',
      target,
      path,
      sourceRoot: repository.root,
      managedRoot,
      name: branch,
      branch,
      baseRevision: head.stdout.trim(),
      status: 'active',
      createdAt,
    }
    return {
      cwd:
        subdirectory === ''
          ? path
          : target.kind === 'local'
            ? join(path, subdirectory)
            : posix.join(path, subdirectory),
      workspace,
    }
  }

  const name = `wrkflw-${safeName(input.runName)}-${input.runId.slice(0, 8)}-${safeName(input.agentId)}`
  const args = [
    '--config',
    'signing.behavior="drop"',
    '--repository',
    repository.root,
    'workspace',
    'add',
    '--name',
    name,
    ...(input.revision === undefined ? [] : ['--revision', input.revision]),
    path,
  ]
  const add = await executeTarget('jj', args, undefined, target)
  assertCommandSuccess(add, `Cannot create jj workspace for ${input.agentId}`)
  const head = await executeTarget(
    'jj',
    ['--repository', path, 'log', '--no-graph', '-r', '@', '-T', 'commit_id'],
    undefined,
    target,
  )
  assertCommandSuccess(head, `Cannot read jj workspace revision for ${input.agentId}`)
  const workspace: ManagedWorkspace = {
    kind: 'jj-workspace',
    target,
    path,
    sourceRoot: repository.root,
    managedRoot,
    name,
    baseRevision: head.stdout.trim(),
    status: 'active',
    createdAt,
  }
  return {
    cwd:
      subdirectory === ''
        ? path
        : target.kind === 'local'
          ? join(path, subdirectory)
          : posix.join(path, subdirectory),
    workspace,
  }
}

function assertManagedPath(workspace: ManagedWorkspace): void {
  const pathApi = workspace.target.kind === 'local' ? { resolve } : posix
  const root = pathApi.resolve(workspace.managedRoot)
  const path = pathApi.resolve(workspace.path)
  if (path === root || !path.startsWith(`${root}/`)) {
    throw new Error(`Refusing to prune unmanaged path ${path}`)
  }
}

async function pruneManagedWorkspaceUnlocked(
  workspace: ManagedWorkspace,
  force = false,
): Promise<PruneResult> {
  assertManagedPath(workspace)
  if (workspace.status === 'pruned') {
    return { path: workspace.path, pruned: true, reason: 'already pruned' }
  }

  if (workspace.kind === 'git-worktree') {
    if (await targetExists(workspace.path, workspace.target)) {
      const status = await executeTarget(
        'git',
        ['-C', workspace.path, 'status', '--porcelain'],
        undefined,
        workspace.target,
      )
      assertCommandSuccess(status, `Cannot inspect ${workspace.path}`)
      if (status.stdout.trim() !== '' && !force) {
        return {
          path: workspace.path,
          pruned: false,
          reason: 'Git worktree has uncommitted changes',
          ...(workspace.branch === undefined ? {} : { branch: workspace.branch }),
        }
      }
      const unlock = await executeTarget(
        'git',
        ['-C', workspace.sourceRoot, 'worktree', 'unlock', workspace.path],
        undefined,
        workspace.target,
      )
      assertCommandSuccess(unlock, `Cannot unlock Git worktree ${workspace.path}`)
      const remove = await executeTarget(
        'git',
        [
          '-C',
          workspace.sourceRoot,
          'worktree',
          'remove',
          ...(force ? ['--force'] : []),
          workspace.path,
        ],
        undefined,
        workspace.target,
      )
      assertCommandSuccess(remove, `Cannot remove Git worktree ${workspace.path}`)
    }
    const prune = await executeTarget(
      'git',
      ['-C', workspace.sourceRoot, 'worktree', 'prune'],
      undefined,
      workspace.target,
    )
    assertCommandSuccess(prune, `Cannot prune Git worktrees in ${workspace.sourceRoot}`)
    let branchRetained = false
    let reason: string | undefined
    if (workspace.branch !== undefined) {
      const exists = await executeTarget(
        'git',
        [
          '-C',
          workspace.sourceRoot,
          'show-ref',
          '--verify',
          '--quiet',
          `refs/heads/${workspace.branch}`,
        ],
        undefined,
        workspace.target,
      )
      const remove = await executeTarget(
        'git',
        ['-C', workspace.sourceRoot, 'branch', '-d', workspace.branch],
        undefined,
        workspace.target,
      )
      if (exists.exitCode === 0 && remove.exitCode !== 0) {
        const upstream = await executeTarget(
          'git',
          [
            '-C',
            workspace.sourceRoot,
            'rev-parse',
            '--verify',
            `${workspace.branch}@{upstream}`,
          ],
          undefined,
          workspace.target,
        )
        const pushed =
          upstream.exitCode === 0
            ? await executeTarget(
                'git',
                [
                  '-C',
                  workspace.sourceRoot,
                  'merge-base',
                  '--is-ancestor',
                  workspace.branch,
                  upstream.stdout.trim(),
                ],
                undefined,
                workspace.target,
              )
            : undefined
        if (pushed?.exitCode === 0) {
          const forceDelete = await executeTarget(
            'git',
            ['-C', workspace.sourceRoot, 'branch', '-D', workspace.branch],
            undefined,
            workspace.target,
          )
          assertCommandSuccess(
            forceDelete,
            `Cannot remove pushed Git branch ${workspace.branch}`,
          )
        } else {
          branchRetained = true
          const detail = remove.stderr.trim()
          reason = detail
            ? `Git retained branch ${workspace.branch}: ${detail}`
            : `Git branch ${workspace.branch} has commits that are not merged or recorded on its upstream`
        }
      }
    }
    return {
      path: workspace.path,
      pruned: true,
      ...(workspace.branch === undefined ? {} : { branch: workspace.branch }),
      ...(branchRetained ? { branchRetained } : {}),
      ...(reason === undefined ? {} : { reason }),
    }
  }

  let finalRevision: string | undefined
  let bookmark: string | undefined
  if (await targetExists(workspace.path, workspace.target)) {
    const candidateBookmark = `wrkflw/${workspace.name.replace(/^wrkflw-/, '')}`
    const preserve = await executeTarget(
      'jj',
      [
        '--config',
        'signing.behavior="drop"',
        '--repository',
        workspace.path,
        'bookmark',
        'set',
        '--allow-backwards',
        '--revision',
        '@',
        candidateBookmark,
      ],
      undefined,
      workspace.target,
    )
    assertCommandSuccess(preserve, `Cannot preserve jj workspace ${workspace.path}`)
    const head = await executeTarget(
      'jj',
      [
        '--repository',
        workspace.path,
        '--ignore-working-copy',
        'log',
        '--no-graph',
        '-r',
        '@',
        '-T',
        'commit_id',
      ],
      undefined,
      workspace.target,
    )
    assertCommandSuccess(head, `Cannot inspect jj workspace ${workspace.path}`)
    finalRevision = head.stdout.trim()
    if (
      workspace.baseRevision === undefined ||
      finalRevision !== workspace.baseRevision
    ) {
      bookmark = candidateBookmark
    } else {
      const discardBookmark = await executeTarget(
        'jj',
        [
          '--repository',
          workspace.sourceRoot,
          '--ignore-working-copy',
          'bookmark',
          'delete',
          candidateBookmark,
        ],
        undefined,
        workspace.target,
      )
      assertCommandSuccess(
        discardBookmark,
        `Cannot remove unchanged jj bookmark ${candidateBookmark}`,
      )
    }
  }
  const forget = await executeTarget(
    'jj',
    ['--repository', workspace.sourceRoot, 'workspace', 'forget', workspace.name],
    undefined,
    workspace.target,
  )
  if (forget.exitCode !== 0 && !forget.stderr.includes('No such workspace')) {
    assertCommandSuccess(forget, `Cannot forget jj workspace ${workspace.name}`)
  }
  await removeDirectory(workspace.path, workspace.target)
  return {
    path: workspace.path,
    pruned: true,
    ...(bookmark === undefined ? {} : { bookmark }),
    ...(finalRevision === undefined ? {} : { finalRevision }),
  }
}

export function pruneManagedWorkspace(
  workspace: ManagedWorkspace,
  force = false,
): Promise<PruneResult> {
  return pruneManagedWorkspaceUnlocked(workspace, force)
}
