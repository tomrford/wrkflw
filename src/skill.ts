import { HARNESS_NAMES, REASONING_LEVELS, TRANSCRIPT_KINDS } from './types.js'

const workflowExample = `import type { Location, Workflow } from 'wrkflw'

const localRepo: Location = { worktree: true }
const miniRepo: Location = {
  target: { kind: 'ssh', host: 'macmini' },
  cwd: '/Users/tomford/code/projects/example',
  worktree: true,
}

const workflow: Workflow = async ({ args, run, parallel }) => {
  const prompt = args.join(' ') || 'Review the current repository.'

  const [implementation, review] = await parallel([
    run({
      id: 'implementation',
      harness: 'claude-code',
      model: 'claude-haiku-4-5',
      reasoning: 'low',
      location: localRepo,
      prompt,
    }),
    run({
      id: 'review',
      harness: 'codex',
      model: 'gpt-5.6-luna',
      reasoning: 'low',
      location: miniRepo,
      prompt: \`Review this task independently: \${prompt}\`,
    }),
  ])

  return { implementation, review }
}

export default workflow`

const topics = {
  overview: `# Wrkflw

Wrkflw runs named TypeScript workflows under detached local workers. Each worker owns
its agent processes and file-backed archive. Several runs can operate and be inspected
independently, including after completion. Remote targets need SSH, the requested CLI
and its own login. They need no Wrkflw install or service. Harness processes stream
output back to their worker; monitoring commands only read the archive.

Commands intended for agents:

- \`wrkflw run <workflow.ts> <name>\` starts a named detached run
- \`wrkflw info <run> [--agent <id>]\` returns live state
- \`wrkflw transcript <run> [filters]\` reads normalised conversation entries
- \`wrkflw search <run> <query>\` searches one run
- \`wrkflw search --all <query>\` searches every stored run
- \`wrkflw journal <run> [filters]\` reads the canonical ordered stream
- \`wrkflw follow <run> [--detail summary|journal|raw]\` follows one run as NDJSON
- \`wrkflw events <run> [--agent <id>] [--after <seq>]\` reads raw stored events
- \`wrkflw stop <run>\` asks the detached worker to stop
- \`wrkflw cleanup <run> [--force]\` retries retained workspace cleanup
- \`wrkflw history prune [run] [--older-than <age>] [--force]\` removes archives
- \`wrkflw skill [topic]\` prints this contract

\`<run>\` accepts a run name or UUID. Names resolve to the newest matching run.
Every inspection command reads the same archive whether the run is live or terminal.
`,
  workflow: `# Workflow module

Export one default function. Wrkflw passes \`args\`, \`run\`, \`preflight\`,
\`parallel\` and \`settle\`.
The workflow can use normal TypeScript control flow, promises, loops and branches.
It may import Wrkflw types because type-only imports disappear at runtime.

\`wrkflw run review.ts review-main\` is the complete normal command. Add
\`-- <workflow-args>\` only when the workflow reads values from \`args\`.

\`\`\`ts
${workflowExample}
\`\`\`
`,
  run: `# run properties

Required properties:

- \`id: string\` is unique within the workflow
- \`harness: ${HARNESS_NAMES.map((name) => `'${name}'`).join(' | ')}\`
- \`model: string\` is an exact model ID, never a provider alias
- \`prompt: string\`

Optional properties:

- \`reasoning: ${REASONING_LEVELS.map((level) => `'${level}'`).join(' | ')}\`
- \`location: Location\` selects the machine, directory and workspace policy
- \`systemPrompt: string\`
- \`resume: AgentSession\` resumes a session in its original harness and location
- \`maxTurns: number\`
- \`outputSchema: OutputSchema\` requests an inferred, locally validated \`output\`

Wrkflw translates reasoning separately for each harness. Claude rejects \`none\`
and \`minimal\`. Codex maps \`none\` to \`minimal\`, rejects \`max\`, and does not
support \`maxTurns\`.

\`outputSchema\` must implement Standard Schema and Standard JSON Schema; Zod 4
schemas do. Wrkflw sends converted JSON Schema to the native SDK, validates the final
value locally and returns it as inferred \`result.output\`. The validated value is
also stored in the run archive. Invalid structured output fails the agent.
`,
  locations: `# Locations

A \`Location\` is a reusable plain value:

\`\`\`ts
import { ssh, type Location } from 'wrkflw'

const miniRepo: Location = {
  target: ssh('macmini'),
  cwd: '/Users/tomford/code/projects/repo',
  worktree: true,
  worktreeRevision: 'main',
}

await parallel([
  run({ id: 'implementation', location: miniRepo, /* agent properties */ }),
  run({ id: 'review', location: miniRepo, /* agent properties */ }),
])
\`\`\`

Properties:

- \`target: { kind: 'local' } | { kind: 'ssh', host: string, sshArgs?: string[] }\`
- \`cwd: string\` selects a source directory on the target
- \`worktree: boolean\` creates an isolated Git worktree or jj workspace; default false
- \`worktreeRevision: string\` selects its Git commit-ish or jj revset

Local locations may omit \`cwd\` and inherit the workflow launch directory. SSH
locations require an absolute \`cwd\`. Reusing a location with \`worktree: true\`
creates one independent workspace for each agent run.
`,
  workspaces: `# Workspaces

\`cwd\`, \`worktree\` and \`worktreeRevision\` belong to the agent's \`location\`.
Agents in one workflow can use different repositories and isolation choices.

Agents run directly in their resolved \`cwd\` by default. Set \`worktree: true\` to
request isolation for that agent. Wrkflw then verifies that \`cwd\` is inside a native
Git or jj working copy and creates one checkout under \`~/.wrkflw/worktrees\`. Three
parallel calls with \`worktree: true\` therefore get 3 independent copies. Invalid
directories fail before the harness starts.

\`\`\`ts
await parallel([
  run({ id: 'api', location: { cwd: '/repos/api', worktree: true }, /* agent properties */ }),
  run({ id: 'web', location: { cwd: '/repos/web', worktree: true }, /* agent properties */ }),
  run({ id: 'docs', location: { cwd: '/repos/docs' }, /* agent properties */ }),
])
\`\`\`

Git uses its own worktree retention lock and a unique \`wrkflw/...\` branch. jj uses a
named native workspace. Wrkflw adds no repository mutex. Set \`worktreeRevision\` to
choose a Git commit-ish or jj revset.

The run worker cleans these workspaces before recording its terminal state. It
retains dirty Git worktrees and Git branches whose commits are neither merged nor on
their upstream, then records a run warning. For jj, setting a temporary
\`wrkflw/...\` bookmark snapshots the workspace. Wrkflw retains it when the revision
changed, removes it when unchanged, then forgets and removes the workspace.

Run \`wrkflw cleanup <run>\` after committing, pushing or integrating retained Git
work. It also cleans workspaces left by a crashed run and marks related warnings
resolved. \`cleanup --force\` explicitly permits deletion of a dirty Git worktree.
History pruning refuses while a managed workspace still requires cleanup.

SSH locations use the same lifecycle over batch SSH. Wrkflw stores remote workspaces
under \`~/.wrkflw/worktrees\` on that machine and needs no remote service.
`,
  context: `# Context transfer

TypeScript values carry context between workflow steps. Pass one agent's \`text\` in
another prompt when agents or harnesses differ.

Pass the returned typed session handle to resume the same harness conversation. It
includes the native harness session ID and resolved location:

\`\`\`ts
const first = await run({ id: 'implementation', location: repo, /* agent properties */ })
if (!first.session) throw new Error('Harness did not return a session')

const second = await run({
  id: 'implementation-review',
  resume: first.session,
  prompt: 'Review your implementation and run the full gate.',
  // same harness and model properties
})
\`\`\`

Wrkflw rejects a different harness or location when resuming. Cross-model transfers
use interpolated prompt text or files in a shared location. Separate named workflow
runs do not inherit context automatically; their transcripts remain available through
the CLI.
`,
  preflight: `# Preflight

Pass the same complete agent option objects to \`preflight\` before calling \`run\`:

\`\`\`ts
const agents = [implementation, review]

await preflight(agents)
const results = await parallel(agents.map((agent) => run(agent)))
\`\`\`

Preflight starts no harnesses. It checks that each harness executable is available on
its target, each directory exists and every \`worktree: true\` location is inside a
native Git or jj working copy. It checks all supplied agents and reports failures in
one \`AggregateError\`.

Call it again for agent specifications created by a later branch. Wrkflw cannot
statically discover arbitrary TypeScript control flow.
`,
  monitoring: `# Monitoring and transcripts

Use \`info\` for a compact snapshot. Add \`--agent <id>\` for one agent's state,
workspace, session and completed result. Use \`follow\` while a run is active. Use
the same commands after completion; they read the retained archive.

Each archive contains atomic \`summary.json\`, canonical \`journal.ndjson\`, and the
worker's stdout and stderr logs. \`journal\` supports \`--agent\`, \`--after\` and
\`--limit\`. Its sequence numbers order lifecycle events and transcript entries in
one stream.

\`transcript\` supports \`--agent\`, \`--kind\`, \`--after\`, \`--before\`, \`--limit\`
and \`--format json|text\`. Kinds are ${TRANSCRIPT_KINDS.map((kind) => `\`${kind}\``).join(', ')}.
It stores user prompts, system prompts, assistant text, reasoning, tool calls, tool
results and errors as numbered entries. Text format coalesces streaming assistant and
reasoning deltas by message; JSON retains every archived entry.

\`search\` performs case-insensitive search over entry content and tool data. Use
\`--all\` instead of a run name to search every stored run.

Follow detail levels:

- \`summary\` emits workflow and agent lifecycle events
- \`journal\` emits every stored event and transcript entry
- \`raw\` emits the underlying native SDK event for agent events

Every line from \`follow\` is independent JSON.

Completed archives persist until \`history prune\` removes them. Bulk pruning requires
\`--older-than\` with an \`m\`, \`h\`, \`d\` or \`w\` unit. Active archives are never
removed. Archives that still point to a managed workspace require \`cleanup\` first;
other unresolved warnings require \`--force\`. Age-based pruning also keeps a derived
hard crash until \`cleanup\` records its terminal timestamp.

\`parallel([...])\` waits for every sibling to finish, then throws one aggregate error
if any failed. Catch it to continue the workflow. \`settle([...])\` instead returns each
fulfilled or rejected outcome and never throws because an operation failed.
`,
} as const

export type SkillTopic = keyof typeof topics

export const skillTopics = Object.keys(topics) as Array<SkillTopic>

export function renderSkill(topic?: string): string {
  if (topic === undefined) return Object.values(topics).join('\n')
  if (!(topic in topics)) {
    throw new Error(`Unknown skill topic ${topic}. Use: ${skillTopics.join(', ')}`)
  }
  return topics[topic as SkillTopic]
}

export { workflowExample }
