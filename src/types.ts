export const HARNESS_NAMES = ['claude-code', 'codex', 'cursor-acp'] as const
export type HarnessName = (typeof HARNESS_NAMES)[number]

export const REASONING_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

export interface LocalTarget {
  kind: 'local'
}

export interface SshTarget {
  kind: 'ssh'
  /** SSH host or alias, as accepted by the local ssh command. */
  host: string
  /** Extra OpenSSH arguments, for example ['-J', 'jump-host']. */
  sshArgs?: Array<string>
}

export type Target = LocalTarget | SshTarget

type WorkspacePolicy =
  | { worktree?: false; worktreeRevision?: never }
  | { worktree: true; worktreeRevision?: string }

type LocalLocation = {
  /** Local locations may omit cwd and use the workflow launch directory. */
  target?: LocalTarget
  cwd?: string
}

type SshLocation = {
  /** SSH host and arguments used for both the harness and workspace lifecycle. */
  target: SshTarget
  /** Absolute source directory on the remote machine. */
  cwd: string
}

/** Reusable machine, source directory and workspace policy. */
export type Location = (LocalLocation | SshLocation) & WorkspacePolicy

/** Exact machine and directory used by one completed agent turn. */
export type ResolvedLocation =
  | { target: LocalTarget; cwd: string; worktree?: false; worktreeRevision?: never }
  | { target: SshTarget; cwd: string; worktree?: false; worktreeRevision?: never }

/** Opaque harness conversation bound to the machine and directory that created it. */
export interface AgentSession {
  id: string
  harness: HarnessName
  location: ResolvedLocation
}

export interface ManagedWorkspace {
  kind: 'git-worktree' | 'jj-workspace'
  target: Target
  path: string
  sourceRoot: string
  managedRoot: string
  name: string
  status: 'active' | 'pruned'
  createdAt: string
  prunedAt?: string
  branch?: string
  bookmark?: string
  baseRevision?: string
  finalRevision?: string
}

export interface AgentRunOptions {
  /** Unique within one workflow. Used for status and event filtering. */
  id: string
  /** Exact model ID. Wrkflw never treats provider names as model aliases. */
  model: string
  harness: HarnessName
  prompt: string
  /** Reusable machine, directory and workspace policy. */
  location?: Location
  reasoning?: ReasoningLevel
  systemPrompt?: string
  /** Resume a previous turn in its original harness and resolved location. */
  resume?: AgentSession
  maxTurns?: number
}

export interface AgentResult {
  id: string
  model: string
  harness: HarnessName
  /** Exact machine and directory used by the harness. Reuse it for another turn. */
  location: ResolvedLocation
  workspace?: ManagedWorkspace
  text: string
  session?: AgentSession
}

export interface PreflightResult {
  id: string
  harness: HarnessName
  executable: string
  target: Target
  cwd: string
  repositoryKind?: 'git' | 'jj'
  repositoryRoot?: string
}

export interface WorkflowContext {
  /** Positional values after `wrkflw run workflow.ts name --`. */
  args: Array<string>
  /** Start one harness turn and wait for its result. */
  run(options: AgentRunOptions): Promise<AgentResult>
  /** Validate harnesses, directories and managed-workspace repositories. */
  preflight(options: ReadonlyArray<AgentRunOptions>): Promise<Array<PreflightResult>>
  /** Run independent operations concurrently and preserve input order. */
  parallel<const T extends ReadonlyArray<Promise<unknown>>>(
    operations: T,
  ): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }>
  /** Wait for every operation and return each outcome without throwing. */
  settle<const T extends ReadonlyArray<Promise<unknown>>>(
    operations: T,
  ): Promise<{ -readonly [K in keyof T]: PromiseSettledResult<Awaited<T[K]>> }>
}

export type Workflow = (context: WorkflowContext) => Promise<unknown> | unknown

export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'stopping'
  | 'stopped'

export type AgentStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped'

export interface AgentState {
  id: string
  model: string
  harness: HarnessName
  target: Target
  cwd: string
  workspace?: ManagedWorkspace
  status: AgentStatus
  startedAt?: string
  finishedAt?: string
  session?: AgentSession
  error?: string
  textChars: number
  eventCount: number
}

export interface RunRecord {
  id: string
  name: string
  workflow: string
  cwd: string
  args: Array<string>
  pid?: number
  status: RunStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  error?: string
  agents: Record<string, AgentState>
}

export interface RunEvent {
  seq: number
  at: string
  runId: string
  type: string
  agentId?: string
  data?: unknown
}

export const TRANSCRIPT_KINDS = [
  'system',
  'user',
  'assistant',
  'reasoning',
  'tool',
  'tool-result',
  'error',
] as const
export type TranscriptKind = (typeof TRANSCRIPT_KINDS)[number]

export interface TranscriptEntry {
  seq: number
  at: string
  runId: string
  agentId: string
  kind: TranscriptKind
  content: string
  messageId?: string
  data?: unknown
}
