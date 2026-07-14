export type {
  AgentResult,
  AgentRunOptions,
  AgentSession,
  AgentState,
  HarnessName,
  JournalEntry,
  Location,
  LocalTarget,
  ManagedWorkspace,
  ReasoningLevel,
  PreflightResult,
  ResolvedLocation,
  RunEvent,
  RunRecord,
  RunStatus,
  RunWarning,
  SshTarget,
  Target,
  TranscriptEntry,
  TranscriptKind,
  Workflow,
  WorkflowContext,
} from './types.js'

export const local = (): import('./types.js').LocalTarget => ({ kind: 'local' })

export const ssh = (
  host: string,
  sshArgs?: Array<string>,
): import('./types.js').SshTarget => ({
  kind: 'ssh',
  host,
  ...(sshArgs === undefined ? {} : { sshArgs }),
})
