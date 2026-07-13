import { spawn } from 'node:child_process'
import type { Target } from './types.js'

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function executeTarget(
  command: string,
  args: Array<string>,
  cwd?: string,
  target: Target = { kind: 'local' },
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child =
      target.kind === 'local'
        ? spawn(command, args, {
            ...(cwd === undefined ? {} : { cwd }),
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn(
            'ssh',
            [
              ...(target.sshArgs ?? []),
              '-o',
              'BatchMode=yes',
              target.host,
              `sh -lc ${quote(
                `${cwd === undefined ? '' : `cd ${quote(cwd)} && `}exec ${[
                  command,
                  ...args,
                ]
                  .map(quote)
                  .join(' ')}`,
              )}`,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      resolveResult({ exitCode: 127, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      resolveResult({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

export function assertCommandSuccess(result: CommandResult, description: string): void {
  if (result.exitCode === 0) return
  throw new Error(
    `${description}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
  )
}
