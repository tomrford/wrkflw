export type {
  AgentResult,
  AgentRunOptions,
  AgentSession,
  AgentState,
  HarnessName,
  Location,
  LocalTarget,
  ManagedWorkspace,
  ReasoningLevel,
  PreflightResult,
  ResolvedLocation,
  RunEvent,
  RunRecord,
  RunStatus,
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
