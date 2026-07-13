import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { preflightAgents } from '../src/preflight.js'

test('checks a harness and managed workspace before agents start', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'wrkflw-preflight-'))
  const bin = join(parent, 'bin')
  const repo = join(parent, 'repo')
  const previousPath = process.env.PATH
  try {
    await mkdir(bin, { recursive: true })
    const codex = join(bin, 'codex')
    await writeFile(codex, '#!/bin/sh\nexit 0\n')
    await chmod(codex, 0o755)
    process.env.PATH = `${bin}:/usr/bin:/bin`
    execFileSync('git', ['init', '-b', 'main', repo])

    const [result] = await preflightAgents(
      [
        {
          id: 'implementation',
          harness: 'codex',
          model: 'gpt-5.6-luna',
          prompt: 'Implement the change.',
          location: { cwd: repo, worktree: true },
        },
      ],
      parent,
    )

    assert.equal(result?.repositoryKind, 'git')
    assert.equal(result?.repositoryRoot, await realpath(repo))
    assert.equal(result?.executable, codex)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(parent, { recursive: true, force: true })
  }
})

test('reports every failed preflight check', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'wrkflw-preflight-errors-'))
  const previousPath = process.env.PATH
  try {
    process.env.PATH = '/usr/bin:/bin'
    await assert.rejects(
      preflightAgents(
        [
          {
            id: 'missing-harness',
            harness: 'claude-code',
            model: 'claude-haiku-4-5',
            prompt: 'Review.',
            location: { cwd: parent },
          },
          {
            id: 'missing-repository',
            harness: 'codex',
            model: 'gpt-5.6-luna',
            prompt: 'Review.',
            location: { cwd: parent, worktree: true },
          },
        ],
        parent,
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError)
        assert.equal(error.errors.length, 2)
        return true
      },
    )
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(parent, { recursive: true, force: true })
  }
})
