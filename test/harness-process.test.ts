import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCodexSshShim, spawnClaudeOverSsh } from '../src/harness-process.js'

function finish(
  child: ReturnType<typeof spawn>,
  input: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin?.end(input)
  })
}

test('native SSH process bridges preserve streams and relocate Codex schemas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrkflw-harness-process-'))
  const bin = join(root, 'bin')
  const log = join(root, 'ssh.ndjson')
  const remoteSchema = join(root, 'remote-schema.json')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(bin))
  const fakeSsh = join(bin, 'ssh')
  await writeFile(
    fakeSsh,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const command = args.at(-1)
if (command === 'mktemp') {
  process.stdout.write(process.env.REMOTE_SCHEMA + '\\n')
  process.exit(0)
}
if (command?.includes("cat >")) {
  writeFileSync(process.env.REMOTE_SCHEMA, readFileSync(0))
  process.exit(0)
}
if (command?.startsWith('rm -f --')) process.exit(0)
const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', () => {
  appendFileSync(process.env.SSH_LOG, JSON.stringify({ args, input: Buffer.concat(chunks).toString() }) + '\\n')
  process.stdout.write('{"type":"thread.started","thread_id":"remote"}\\n')
})
`,
  )
  await chmod(fakeSsh, 0o700)

  const previousPath = process.env.PATH
  process.env.PATH = `${bin}:${previousPath ?? ''}`
  process.env.SSH_LOG = log
  process.env.REMOTE_SCHEMA = remoteSchema
  try {
    const claude = spawnClaudeOverSsh(
      { kind: 'ssh', host: 'mini', sshArgs: ['-p', '2222'] },
      "/remote/repo's copy",
      {
        command: 'claude',
        args: ['--model', 'claude-haiku-4-5'],
        cwd: '/ignored-local-cwd',
        env: {
          CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
          CLAUDE_AGENT_SDK_VERSION: 'test-version',
        },
        signal: new AbortController().signal,
      },
    ) as ReturnType<typeof spawn>
    const claudeResult = await finish(claude, 'claude-input')
    assert.equal(claudeResult.code, 0, claudeResult.stderr)
    assert.match(claudeResult.stdout, /thread\.started/)

    const localSchema = join(root, 'local-schema.json')
    await writeFile(localSchema, '{"type":"object"}')
    const shim = await createCodexSshShim(
      { kind: 'ssh', host: 'mini', sshArgs: ['-p', '2222'] },
      '/remote/repo',
    )
    try {
      const codex = spawn(
        shim.path,
        ['exec', '--experimental-json', '--output-schema', localSchema],
        { env: { ...process.env, PATH: process.env.PATH } },
      )
      const codexResult = await finish(codex, 'codex-input')
      assert.equal(codexResult.code, 0, codexResult.stderr)
      assert.match(codexResult.stdout, /thread\.started/)
    } finally {
      await shim.cleanup()
    }

    assert.equal(await readFile(remoteSchema, 'utf8'), '{"type":"object"}')
    const entries = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; input: string })
    assert.equal(entries[0]?.input, 'claude-input')
    assert.match(entries[0]?.args.at(-1) ?? '', /claude-haiku-4-5/)
    assert.match(entries[0]?.args.at(-1) ?? '', /env -u ANTHROPIC_API_KEY/)
    assert.match(entries[0]?.args.at(-1) ?? '', /CLAUDE_CODE_ENTRYPOINT/)
    assert.equal(entries[1]?.input, 'codex-input')
    assert.match(entries[1]?.args.at(-1) ?? '', new RegExp(remoteSchema))
    assert.doesNotMatch(entries[1]?.args.at(-1) ?? '', new RegExp(localSchema))
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    delete process.env.SSH_LOG
    delete process.env.REMOTE_SCHEMA
  }
})
