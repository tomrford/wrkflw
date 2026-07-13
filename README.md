# Wrkflw

Wrkflw runs code-first workflows across local coding-agent CLIs. An agent writes one
TypeScript file, starts a named run and receives its state while it continues in a
detached worker.

Version 1 supports Claude Code, Codex CLI and Cursor Agent through ACP. Models are
always exact strings such as `claude-haiku-4-5` or `gpt-5.6-luna`. The harness,
reasoning level and execution target are separate properties.

## Install

Wrkflw requires Node.js 22 or newer:

```text
pnpm add --global wrkflw
```

## Run a workflow

A workflow is normal TypeScript. There is no workflow YAML or JSON.

```ts
import type { Location, Workflow } from 'wrkflw'

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
      prompt: `Review this task independently: ${prompt}`,
    }),
  ])

  return { implementation, review }
}

export default workflow
```

The canonical copy is [the basic workflow example](examples/basic.workflow.ts).

Start it from the repository that local agents should work on:

```text
wrkflw run review.workflow.ts review-main
```

This is the complete normal command. A run name uses letters, numbers, dots, dashes
or underscores. Add values after `--` only if the workflow reads `args`:

```text
wrkflw run review.workflow.ts review-pr-123 -- 123 --deep
```

Here, `review-pr-123` is the run name. The workflow receives `123` and `--deep`.

## Inspect a live run

Each run has one detached worker, UUID, name, state file, transcript and event log.
There is no permanent central daemon. You can run and inspect several workflows at
the same time. After its initial queued record is created, that worker is the sole
writer for the run. Harness processes stream back to it; monitoring commands only
read its files.

```text
wrkflw list
wrkflw info review-main
wrkflw info review-main --agent implementation
wrkflw follow review-main --detail summary
wrkflw events review-main --agent implementation --after 20
```

Names resolve to the newest matching run. UUIDs remain available for exact historical
lookup.

## Read and search transcripts

Wrkflw records normalised transcript entries alongside raw TanStack AG-UI events.
Entries include system and user prompts, assistant text, reasoning, tool calls, tool
results and errors.

```text
wrkflw transcript review-main --agent implementation
wrkflw transcript review-main --kind reasoning --after 20 --before 40
wrkflw transcript review-main --limit 30 --format text
wrkflw search review-main "permission denied"
wrkflw search --all "model_reasoning_effort" --kind tool
```

JSON is the default for agent callers. `follow` emits NDJSON so a caller can process
events while the run is active.

## Reuse locations

A `Location` is a plain value containing the machine, source directory and workspace
policy. Reuse it when several agents start in the same place:

```ts
import { ssh, type Location } from 'wrkflw'

const repo: Location = {
  target: ssh('macmini'),
  cwd: '/Users/tomford/code/projects/example',
  worktree: true,
  worktreeRevision: 'main',
}

await parallel([
  run({ id: 'implementation', location: repo, /* agent properties */ }),
  run({ id: 'review', location: repo, /* agent properties */ }),
])
```

Local locations default to the workflow launch directory. SSH locations require an
absolute `cwd`. A workflow can mix repositories and isolation choices:

```ts
await parallel([
  run({
    id: 'api',
    location: { cwd: '/Users/tomford/code/projects/api', worktree: true },
    // harness, model and prompt
  }),
  run({
    id: 'web',
    location: { cwd: '/Users/tomford/code/projects/web', worktree: true },
    // harness, model and prompt
  }),
  run({
    id: 'docs',
    location: { cwd: '/Users/tomford/code/projects/docs' },
    // harness, model and prompt
  }),
])
```

## Opt into isolated workspaces

Agents run directly in their resolved directory by default. Set `worktree: true` in
the location to give that agent an isolated checkout under `~/.wrkflw/worktrees` on
the selected machine.

Wrkflw verifies that `cwd` is inside a native Git or jj working copy. It fails that
agent before starting its harness when the directory is not a supported repository.

Reusing a location with `worktree: true` creates one independent workspace for each
agent run. Git worktrees use Git's own `worktree add --lock` retention flag and unique
`wrkflw/...` branches. jj workspaces use unique native workspace names. Wrkflw adds no
repository mutex around either VCS.

Prune managed workspaces after inspecting or integrating their work:

```text
wrkflw prune review-main
wrkflw prune
```

Safe pruning only processes terminal runs. It retains Git worktrees with uncommitted
changes unless you pass `--force`. Git branches with unmerged commits remain in the
source repository.

Wrkflw sets a `wrkflw/...` bookmark before pruning a jj workspace. Setting the
bookmark snapshots the working copy. If the revision changed, Wrkflw retains the
bookmark before forgetting and removing the workspace. If it did not change, Wrkflw
removes the temporary bookmark.

SSH locations use the same lifecycle over batch SSH. Wrkflw creates workspaces under
`~/.wrkflw/worktrees` on the remote machine and records enough target information to
prune them later. The remote machine does not run a Wrkflw service.

## Transfer context between turns

The workflow transfers context explicitly. JavaScript values move between steps, so
one agent's `text` can become another agent's prompt.

Use the returned session handle to resume the same harness conversation. The handle
binds the harness session ID to its resolved machine and directory:

```ts
const first = await run({
  id: 'implementation',
  location: repo,
  // harness, model and prompt
})
if (!first.session) throw new Error('Harness did not return a session')

const second = await run({
  id: 'implementation-review',
  resume: first.session,
  prompt: 'Review your implementation and run the full gate.',
  // same harness and model
})
```

Wrkflw rejects attempts to resume the session through a different harness or
location. Cross-model transfers use prompt text or files in a shared location:

```ts
const review = await run({
  id: 'review',
  prompt: `Your next job is to review the code.

Here is what the implementation agent said:

${first.text}`,
  // different harness, model and location
})
```

Separate named workflow runs do not inherit context automatically. Their state and
transcripts remain available through the CLI.

## Check agents before starting

Preflight the same agent specifications that the workflow will run:

```ts
const agents = [implementation, review]

await preflight(agents)
const results = await parallel(agents.map((agent) => run(agent)))
```

`preflight` checks every declared agent before starting any harness. It verifies that:

- the selected harness executable is available on its target machine
- the target directory exists
- `worktree: true` points inside a native Git or jj working copy

It reports all failures together. Workflows can call it again for agent specifications
created by a later branch. Wrkflw does not try to statically inspect arbitrary
TypeScript control flow.

## Handle agent failures

`parallel([...])` waits for every sibling operation to finish. It then throws an
`AggregateError` if one or more failed. An uncaught error fails the workflow after the
remaining agents settle. Catch it when the script should continue.

Use `settle([...])` when the workflow needs every individual result without an
exception:

```ts
const outcomes = await settle([
  run(first),
  run(second),
  run(third),
])
```

Each outcome has `status: 'fulfilled'` with `value`, or `status: 'rejected'` with
`reason`. Workspace provisioning failures affect only their own agent operation.

## Use SSH locations

An SSH location starts the selected harness through the system OpenSSH client:

```ts
location: {
  target: { kind: 'ssh', host: 'macmini' },
  cwd: '/Users/tomford/code/projects/repo',
  worktree: true,
}
```

The remote machine does not need Wrkflw or a daemon. It needs batch SSH access, the
requested directory, Git or jj for managed workspaces, the agent CLI on its
non-interactive PATH and that CLI's own login. The SSH process carries ACP or native
CLI streams back to the local worker.

The local-process and SSH providers select where a process runs. They are not security
containers. Wrkflw uses the installed TanStack adapter's permission defaults.

## Use the agent contract

`wrkflw skill` prints the whole agent-facing contract. A topic returns only the needed
section:

```text
wrkflw skill workflow
wrkflw skill run
wrkflw skill locations
wrkflw skill workspaces
wrkflw skill context
wrkflw skill preflight
wrkflw skill monitoring
```

State defaults to `~/.wrkflw/state`. Set `WRKFLW_HOME` to move managed worktrees or
`WRKFLW_STATE_DIR` to move run state.

[Wrkflw architecture](docs/architecture.md) defines the process, workspace, transcript
and authentication boundaries.

## Develop Wrkflw

Use the pinned pnpm version. The full gate checks formatting, lint, types, tests,
documentation and the production build:

```text
pnpm check
```
