import { spawn } from 'node:child_process'
import { basename, posix } from 'node:path'
import { DEFAULT_WORKSPACE_ROOT, createExecBackedGit } from '@tanstack/ai-sandbox'
import type { ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import type {
  ExecResult,
  ProcessOptions,
  SandboxCapabilities,
  SandboxCreateInput,
  SandboxDestroyInput,
  SandboxHandle,
  SandboxProvider,
  SandboxResumeInput,
  SpawnHandle,
} from '@tanstack/ai-sandbox'

const SSH_CAPABILITIES: SandboxCapabilities = {
  fs: true,
  exec: true,
  env: true,
  ports: false,
  backgroundProcesses: true,
  writableStdin: true,
  snapshots: false,
  networkPolicy: false,
  durableFilesystem: true,
  fork: false,
}

export interface SshProcessSandboxConfig {
  host: string
  dir: string
  sshArgs?: Array<string>
  scrubEnv?: Array<string>
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function* decodeStream(stream: Readable | null): AsyncIterable<string> {
  if (!stream) return
  for await (const chunk of stream) {
    yield typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8')
  }
}

function collect(child: ChildProcess): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf8')
    })
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }))
  })
}

class SshProcessHandle implements SandboxHandle {
  readonly id: string
  readonly provider = 'ssh-process'
  readonly capabilities = SSH_CAPABILITIES
  readonly fs: SandboxHandle['fs']
  readonly git: SandboxHandle['git']
  readonly process: SandboxHandle['process']
  readonly ports: SandboxHandle['ports']
  readonly env: SandboxHandle['env']

  private readonly envVars: Record<string, string> = {}

  constructor(private readonly config: SshProcessSandboxConfig) {
    this.id = `ssh://${config.host}${config.dir}`

    this.process = {
      exec: (command, options) => this.exec(command, options),
      spawn: (command, options) => this.spawnProcess(command, options),
    }
    this.git = createExecBackedGit(this.process, DEFAULT_WORKSPACE_ROOT)
    this.ports = {
      connect: () =>
        Promise.reject(
          new Error('ssh-process does not expose remote ports in version 1'),
        ),
    }
    this.env = {
      set: async (variables) => {
        Object.assign(this.envVars, variables)
      },
    }
    this.fs = {
      read: async (path) => {
        const result = await this.exec(`cat -- ${quote(this.resolve(path))}`)
        this.assertSuccess(result, `read ${path}`)
        return result.stdout
      },
      readBytes: async (path) => {
        const result = await this.exec(`base64 < ${quote(this.resolve(path))}`)
        this.assertSuccess(result, `read ${path}`)
        return new Uint8Array(Buffer.from(result.stdout.replace(/\s/g, ''), 'base64'))
      },
      write: async (path, data) => {
        const target = this.resolve(path)
        const command = `mkdir -p -- ${quote(posix.dirname(target))} && cat > ${quote(target)}`
        const child = this.spawnSsh(this.remoteScript(command))
        const resultPromise = collect(child)
        child.stdin?.end(typeof data === 'string' ? data : Buffer.from(data))
        this.assertSuccess(await resultPromise, `write ${path}`)
      },
      list: async (path) => {
        const target = this.resolve(path)
        const command = [`find ${quote(target)} -mindepth 1 -maxdepth 1 -print`].join(
          ' ',
        )
        const result = await this.exec(command)
        this.assertSuccess(result, `list ${path}`)
        const entries = result.stdout.split('\n').filter(Boolean)
        return Promise.all(
          entries.map(async (entry) => {
            const kind = await this.exec(`test -d ${quote(entry)}`)
            return {
              name: basename(entry),
              path: `${path.replace(/\/$/, '')}/${basename(entry)}`,
              type: kind.exitCode === 0 ? ('dir' as const) : ('file' as const),
            }
          }),
        )
      },
      mkdir: async (path) => {
        const result = await this.exec(`mkdir -p -- ${quote(this.resolve(path))}`)
        this.assertSuccess(result, `mkdir ${path}`)
      },
      remove: async (path) => {
        const result = await this.exec(`rm -rf -- ${quote(this.resolve(path))}`)
        this.assertSuccess(result, `remove ${path}`)
      },
      rename: async (from, to) => {
        const result = await this.exec(
          `mv -- ${quote(this.resolve(from))} ${quote(this.resolve(to))}`,
        )
        this.assertSuccess(result, `rename ${from}`)
      },
      exists: async (path) => {
        const result = await this.exec(`test -e ${quote(this.resolve(path))}`)
        return result.exitCode === 0
      },
    }
  }

  private resolve(path: string): string {
    let relative = path
    if (path === DEFAULT_WORKSPACE_ROOT) relative = ''
    else if (path.startsWith(`${DEFAULT_WORKSPACE_ROOT}/`)) {
      relative = path.slice(DEFAULT_WORKSPACE_ROOT.length + 1)
    } else if (path.startsWith('/')) {
      relative = path.slice(1)
    }

    const resolved = posix.resolve(this.config.dir, relative)
    const root = posix.resolve(this.config.dir)
    if (resolved !== root && !resolved.startsWith(`${root}/`)) {
      throw new Error(`ssh-process path ${JSON.stringify(path)} escapes ${root}`)
    }
    return resolved
  }

  private resolveCwd(cwd: string | undefined): string {
    if (cwd === undefined) return posix.resolve(this.config.dir)
    if (cwd === this.config.dir || cwd.startsWith(`${this.config.dir}/`)) return cwd
    return this.resolve(cwd)
  }

  private remoteScript(command: string, options?: ProcessOptions): string {
    const cwd = this.resolveCwd(options?.cwd)
    const merged = { ...this.envVars, ...options?.env }
    const envArguments = Object.entries(merged).map(([key, value]) =>
      quote(`${key}=${value}`),
    )
    const unsetArguments = (this.config.scrubEnv ?? []).map(quote)
    const env = [
      'env',
      ...unsetArguments.flatMap((key) => ['-u', key]),
      ...envArguments,
    ].join(' ')
    return `cd ${quote(cwd)} && exec ${env} sh -c ${quote(command)}`
  }

  private spawnSsh(script: string): ChildProcess {
    const args = [
      ...(this.config.sshArgs ?? []),
      '-o',
      'BatchMode=yes',
      this.config.host,
      `sh -lc ${quote(script)}`,
    ]
    return spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  }

  private exec(command: string, options?: ProcessOptions): Promise<ExecResult> {
    const child = this.spawnSsh(this.remoteScript(command, options))
    const onAbort = (): void => {
      child.kill('SIGTERM')
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true })
    return collect(child).finally(() => {
      options?.signal?.removeEventListener('abort', onAbort)
    })
  }

  private async spawnProcess(
    command: string,
    options?: ProcessOptions,
  ): Promise<SpawnHandle> {
    const child = this.spawnSsh(this.remoteScript(command, options))
    options?.signal?.addEventListener('abort', () => child.kill('SIGTERM'), {
      once: true,
    })
    return {
      pid: child.pid ?? -1,
      stdout: decodeStream(child.stdout),
      stderr: decodeStream(child.stderr),
      stdin: {
        write: (data) =>
          new Promise<void>((resolve, reject) => {
            child.stdin?.write(data, (error) => (error ? reject(error) : resolve()))
          }),
        end: () =>
          new Promise<void>((resolve) => {
            child.stdin?.end(resolve)
          }),
      },
      wait: () =>
        new Promise<number>((resolve, reject) => {
          child.on('error', reject)
          child.on('close', (code) => resolve(code ?? 0))
        }),
      kill: async (signal) => {
        child.kill(signal)
      },
    }
  }

  private assertSuccess(result: ExecResult, operation: string): void {
    if (result.exitCode === 0) return
    throw new Error(
      `ssh-process could not ${operation} on ${this.config.host}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    )
  }

  async destroy(): Promise<void> {
    // Existing remote workspaces are user-owned. Never remove them.
  }
}

class SshProcessProvider implements SandboxProvider {
  readonly name = 'ssh-process'

  constructor(private readonly config: SshProcessSandboxConfig) {}

  capabilities(): SandboxCapabilities {
    return SSH_CAPABILITIES
  }

  async create(_input: SandboxCreateInput): Promise<SandboxHandle> {
    const handle = new SshProcessHandle(this.config)
    const result = await handle.process.exec('pwd')
    if (result.exitCode !== 0) {
      throw new Error(
        `Cannot use ${this.config.host}:${this.config.dir}: ${result.stderr.trim()}`,
      )
    }
    return handle
  }

  async resume(_input: SandboxResumeInput): Promise<SandboxHandle | null> {
    try {
      return await this.create({} as SandboxCreateInput)
    } catch (error) {
      if (messageOf(error).includes('No such file')) return null
      throw error
    }
  }

  async destroy(_input: SandboxDestroyInput): Promise<void> {
    // Existing remote workspaces are user-owned. Never remove them.
  }
}

export function sshProcessSandbox(config: SshProcessSandboxConfig): SandboxProvider {
  if (!config.host.trim()) throw new Error('SSH target host is required')
  if (!posix.isAbsolute(config.dir)) {
    throw new Error(`SSH target cwd must be absolute: ${config.dir}`)
  }
  return new SshProcessProvider(config)
}
