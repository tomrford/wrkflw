# Architecture

Wrkflw separates agent selection from location:

- `model` is an exact model ID
- `reasoning` maps to the selected CLI's reasoning control
- `harness` selects Claude Code, Codex CLI or Cursor ACP
- `location` groups the target machine, source directory and workspace policy

The same model can be available through several harnesses. Wrkflw therefore does not
infer a harness from a model ID.

## Named run lifecycle

`wrkflw run workflow.ts name` creates a run directory and starts one detached Node
worker. The worker imports the TypeScript workflow with tsx and owns every harness
child started by that workflow.

There is no permanent central daemon. Each run has an independent PID and lifetime.
One blocked or failed workflow does not stop another run.

The worker stores:

- `run.json` as an atomic current-state snapshot
- `events.ndjson` as the raw lifecycle and harness stream
- `transcript.ndjson` as normalised searchable conversation entries
- `worker.stdout.log` and `worker.stderr.log`

The launcher writes the initial queued record before the worker exists. After spawn,
the worker is the only process that writes run state, events and transcripts. Harness
children stream their output back to that worker and never write Wrkflw files.
Inspection commands only read these files. After the run is terminal, `prune` may
update its managed-workspace metadata.

Commands accept a UUID or name. A name resolves to the newest matching record. Wrkflw
rejects a new run when the same name is active, but you can reuse a name after it
finishes.

`info` compares non-terminal state with the worker PID. If the worker disappeared
without recording a terminal state, it reports a derived failed view without writing
over the worker's record. `stop` sends `SIGTERM`; the worker records `stopping`, aborts
active harness streams and records the terminal state.

## Transcript and event model

Wrkflw keeps raw AG-UI chunks for complete debugging. It also extracts useful content
into ordered transcript entries:

- system and user prompts
- assistant text deltas
- reasoning deltas
- tool names and argument deltas
- tool results
- run errors

`transcript` filters entries by agent, kind and sequence range. `search` searches entry
content and stored tool data in one run or all runs. The raw event log remains the
source for protocol-level inspection.

## Managed repository isolation

`Location` is a reusable plain value. It contains `target`, `cwd`, `worktree` and
`worktreeRevision`. One workflow can use several locations. Reusing a location with
`worktree: true` creates a separate workspace for every agent run.

Local locations may omit `cwd` and use the workflow launch directory. SSH locations
require an absolute `cwd`.

Agents use their resolved `cwd` directly by default. `worktree: true` asks Wrkflw to
detect the Git or native jj working copy containing that directory. It preserves the
relative subdirectory inside the new checkout. Missing or unsupported repositories
fail that agent before its harness starts.

Managed paths have this shape on the selected machine:

```text
~/.wrkflw/worktrees/<repo-name>-<source-hash>/<run-name>-<run-id>/<agent-id>
```

The source hash prevents repositories with the same basename from colliding. The run
ID prevents reused run names from colliding. A managed workspace record includes its
target and managed root, so pruning uses the same machine and path boundary.

For Git, Wrkflw creates and locks a worktree at `HEAD` or the requested revision. It
creates a unique `wrkflw/...` branch so agent commits remain reachable after workspace
pruning. Safe pruning refuses uncommitted changes. It removes a branch only when
`git branch -d` considers that safe.

Wrkflw does not add repository mutexes around these commands. Git and jj provide their
own concurrency handling; Wrkflw reports any command failure they return.

For jj, Wrkflw uses `jj workspace add --name`. It records the initial working-copy
commit ID. The empty management commit disables signing so workspace creation does not
need an interactive signing key. Agent commands keep the repository's normal signing
policy. Pruning first sets a `wrkflw/...` bookmark, which snapshots the workspace. It
retains the bookmark when the revision changed and removes it when nothing changed.
It then uses `jj workspace forget` to remove the live workspace reference and removes
the owned directory.

`--force` only applies to paths contained by the configured Wrkflw worktree root.
Wrkflw refuses to prune active runs or paths outside that root.

## Workflow execution

The workflow receives `run`, `preflight`, `parallel`, `settle` and optional positional
`args`.
Each `run(...)` independently resolves its location. `worktree: true` in that location
provisions a workspace before starting its harness. Agent state records the resolved
target and `cwd`, workspace path, VCS kind, branch or workspace name and base revision.

`parallel` uses all-settled execution internally. It waits for every sibling and then
throws an aggregate error if any failed. The workflow may catch that error and
continue. `settle` returns each fulfilled or rejected result without throwing.

The result contains final text, a typed session handle and the resolved location. The
session handle binds the native harness session ID to its harness, machine and
directory. A later turn passes it as `resume`. Wrkflw rejects a different harness or
location before resuming.

Cross-harness steps transfer context through prompt text or files. Separate named runs
retain searchable transcripts but do not inherit context automatically.

`preflight` accepts the same agent option objects as `run`. It checks harness
executables, directories and requested repository isolation without starting an
agent. It collects failures across the supplied list. Workflows invoke preflight
explicitly because arbitrary TypeScript branches cannot be discovered statically.

Normal TypeScript supplies sequencing, fan-out, joins, retries and branching. Wrkflw
does not reproduce those controls in a configuration language.

## SSH boundary

The SSH provider implements TanStack's process and file interface through the system
`ssh` client in batch mode. Login-shell startup makes the remote CLI PATH available.
ACP messages or native CLI streams use the SSH process's stdin, stdout and stderr.

The remote machine does not run Wrkflw. It needs:

- non-interactive SSH authentication
- the requested directory
- Git or native jj when the location requests a managed workspace
- the requested agent CLI on the login PATH
- that CLI's authenticated subscription session

Workspace creation, inspection and pruning use short-lived SSH commands. Remote
workspaces live under `~/.wrkflw/worktrees` unless the remote login environment sets
`WRKFLW_HOME`. Run state and transcripts remain on the machine that started Wrkflw.

## Authentication and permissions

Each CLI uses its login on the machine where it runs. Wrkflw removes
`ANTHROPIC_API_KEY`, `CODEX_API_KEY` and `OPENAI_API_KEY` from harness children so an
inherited API key does not silently replace a subscription login.

Wrkflw does not override TanStack harness permission or sandbox defaults. Local-process
and SSH providers select a process location but do not isolate the host like a VM or
container. Workflows must use trusted scripts, targets and repositories.

## Current limits

- there is no central scheduler, resource quota or global concurrency limit
- there is no preference file or implicit model-to-harness routing
- interactive permission approval is not exposed as a Wrkflw command
- run state is local to the machine that started Wrkflw
