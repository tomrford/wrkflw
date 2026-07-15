import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import type { SshTarget } from './types.js'

const API_KEYS = ['ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'OPENAI_API_KEY'] as const
const CLAUDE_SDK_ENV = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION'] as const

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function subscriptionEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !API_KEYS.includes(key as (typeof API_KEYS)[number])) {
      environment[key] = value
    }
  }
  return environment
}

function remoteShell(
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  environment: SpawnOptions['env'],
): string {
  const invocation = [command, ...args].map(quote).join(' ')
  const sdkEnvironment = CLAUDE_SDK_ENV.flatMap((key) => {
    const value = environment[key]
    return value === undefined ? [] : [`${key}=${quote(value)}`]
  })
  return `sh -lc ${quote(
    `cd ${quote(cwd)} && exec env ${[
      ...API_KEYS.map((key) => `-u ${key}`),
      ...sdkEnvironment,
    ].join(' ')} ${invocation}`,
  )}`
}

export function spawnClaudeOverSsh(
  target: SshTarget,
  cwd: string,
  options: SpawnOptions,
): SpawnedProcess {
  return spawn(
    'ssh',
    [
      ...(target.sshArgs ?? []),
      '-o',
      'BatchMode=yes',
      target.host,
      remoteShell(cwd, options.command, options.args, options.env),
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    },
  )
}

export interface CodexSshShim {
  path: string
  cleanup(): Promise<void>
}

/**
 * The Codex SDK invokes a local executable and supplies a local output-schema file.
 * This short-lived shim copies that schema to the target, then streams Codex JSONL
 * over SSH without requiring Wrkflw or Node.js on the remote machine.
 */
export async function createCodexSshShim(
  target: SshTarget,
  cwd: string,
): Promise<CodexSshShim> {
  const directory = await mkdtemp(join(tmpdir(), 'wrkflw-codex-ssh-'))
  const path = join(directory, 'codex-ssh.mjs')
  const source = `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'

const ssh = ${JSON.stringify([
    ...(target.sshArgs ?? []),
    '-o',
    'BatchMode=yes',
    target.host,
  ])}
const cwd = ${JSON.stringify(cwd)}
const quote = (value) => "'" + value.replaceAll("'", "'\\\\''") + "'"
const args = process.argv.slice(2)
let remoteSchema
const schemaIndex = args.indexOf('--output-schema')
if (schemaIndex !== -1) {
  const created = spawnSync('ssh', [...ssh, 'mktemp'], { encoding: 'utf8' })
  if (created.status !== 0) {
    process.stderr.write(created.stderr || 'Cannot create remote output schema file\\n')
    process.exit(created.status ?? 1)
  }
  remoteSchema = created.stdout.trim()
  const copied = spawnSync(
    'ssh',
    [...ssh, ${JSON.stringify(`sh -c 'cat > "$1"' wrkflw-schema `)} + quote(remoteSchema)],
    { input: readFileSync(args[schemaIndex + 1]) },
  )
  if (copied.status !== 0) {
    spawnSync('ssh', [...ssh, 'rm -f -- ' + quote(remoteSchema)])
    process.exit(copied.status ?? 1)
  }
  args[schemaIndex + 1] = remoteSchema
}
const command = 'sh -lc ' + quote(
  'cd ' + quote(cwd) +
  ' && exec env -u ANTHROPIC_API_KEY -u CODEX_API_KEY -u OPENAI_API_KEY codex ' +
  args.map(quote).join(' '),
)
const child = spawn('ssh', [...ssh, command], { stdio: ['pipe', 'pipe', 'pipe'] })
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', (error) => {
  process.stderr.write(error.message + '\\n')
  process.exitCode = 127
})
child.on('close', (code, signal) => {
  if (remoteSchema) spawnSync('ssh', [...ssh, 'rm -f -- ' + quote(remoteSchema)])
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
`
  await writeFile(path, source)
  await chmod(path, 0o700)
  return {
    path,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
