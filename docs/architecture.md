# Architecture

Wrkflw separates agent selection from location:

- `model` is an exact model ID
- `reasoning` maps to the selected CLI's reasoning control
- `harness` selects Claude Code or Codex
- `location` groups the target machine, source directory and workspace policy

The same model can be available through several harnesses. Wrkflw therefore does not
infer a harness from a model ID.

## Named run lifecycle

`wrkflw run workflow.ts name` creates a run directory and starts one detached Node
worker. The worker imports the TypeScript workflow with tsx and owns every harness
child started by that workflow.

There is no permanent central daemon. Each run has an independent PID and lifetime.
One blocked or failed workflow does not stop another run.

The worker creates and stores:

- `summary.json` as an atomic current-state snapshot
- `journal.ndjson` as the canonical ordered event and transcript stream
- `worker.stdout.log` and `worker.stderr.log`

The launcher creates the run directory, connects the worker's logs and passes its
bootstrap data through the environment. The worker removes that variable before it
starts a harness and creates the initial summary itself. While the run is live, it is
the only process that writes summary and journal records. Harness children stream
their output back to the worker and never write Wrkflw files. A later explicit
cleanup retry uses its own short-lived maintenance worker. Inspection commands always
read the archive; there is no separate live status protocol.

Commands accept a UUID or name. A name resolves to the newest matching record. Wrkflw
rejects a new run when the same name is active, but you can reuse a name after it
finishes.

Launchers claim the active name with one atomic directory reservation outside the run
archive. This closes the only cross-process race between simultaneous launch commands;
it does not let launchers write workflow state or add VCS locks. The worker releases
the reservation after terminal state is durable. A later launcher can recover a stale
reservation by reconciling its run record.

`info` compares non-terminal state with the worker PID. If the worker disappeared
without recording a terminal state, it reports a derived `crashed` view without
writing over the worker's last coherent record. `stop` sends `SIGTERM`; the worker
records `stopping`, aborts active harness streams and records the terminal state.

Before writing the terminal event and summary, the worker cleans up every managed
workspace it created. Cleanup outcomes enter the journal. Dirty Git worktrees and
unpushed or unmerged Git branches are retained and added to `summary.json` as
warnings. jj workspaces are bookmarked when changed, forgotten and removed. Cleanup
failure does not replace the workflow's own success or failure status.

`cleanup` starts a short-lived maintenance worker for a terminal run. It retries
workspace teardown after retained work is committed, pushed or integrated, and marks
the related warnings resolved. It can also canonicalise a derived crash record before
cleaning workspaces left by a hard worker exit. `cleanup --force` is the separate,
explicit path for discarding a dirty Git worktree. Canonicalising a hard crash also
records when it was observed.

Completed archives remain in place for inspection. `history prune` removes terminal
archives as a separate retention operation. Bulk pruning requires an age, and
archives with unresolved warnings require `--force`. History pruning still refuses
an archive that points to a managed workspace requiring cleanup, so it cannot erase
the only record of retained work. Age-based bulk pruning also retains a derived crash
until `cleanup` establishes its terminal timestamp.

## Journal model

Every append to `journal.ndjson` receives one run-global sequence number. The stream
contains Wrkflw lifecycle events, raw native SDK events and normalised transcript
entries.
The transcript projection includes:

- system and user prompts
- assistant text
- reasoning
- tool names and calls
- tool results
- run errors

`journal` reads the complete stream. `events` and `transcript` are filtered projections
of that same file. `transcript` filters by agent, kind and sequence range. `search`
searches entry content and stored tool data in one run or all runs. `follow` tails the
same journal that later inspection reads, advancing by byte offset rather than
reparsing prior entries. The text transcript projection coalesces adjacent assistant
and reasoning deltas with the same message ID. JSON transcripts and the journal retain
the original deltas and sequence numbers.

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
target and managed root, so cleanup uses the same machine and path boundary.

For Git, Wrkflw creates and locks a worktree at `HEAD` or the requested revision. It
creates a unique `wrkflw/...` branch so agent commits remain reachable after workspace
cleanup. Safe cleanup refuses to remove a worktree with uncommitted changes. It
removes a branch when Git considers that safe, or when all commits are recorded on
its upstream. Otherwise it retains the branch and records a warning.

Wrkflw does not add repository mutexes around these commands. Git and jj provide their
own concurrency handling; Wrkflw reports any command failure they return.

For jj, Wrkflw uses `jj workspace add --name`. It records the initial working-copy
commit ID. The empty management commit disables signing so workspace creation does not
need an interactive signing key. Agent commands keep the repository's normal signing
policy. Cleanup first sets a `wrkflw/...` bookmark, which snapshots the workspace. It
retains the bookmark when the revision changed and removes it when nothing changed.
It then uses `jj workspace forget` to remove the live workspace reference and removes
the owned directory.

Wrkflw only removes paths contained by the configured worktree root. It does not
force automatic Git cleanup; retained work is reported in the run archive.

## Workflow execution

The workflow receives `run`, `preflight`, `parallel`, `settle` and optional positional
`args`.
Each `run(...)` independently resolves its location. `worktree: true` in that location
provisions a workspace before starting its harness. Agent state records the resolved
target and `cwd`, workspace path, VCS kind, branch or workspace name and base revision.

`parallel` uses all-settled execution internally. It waits for every sibling and then
throws an aggregate error if any failed. The workflow may catch that error and
continue. `settle` returns each fulfilled or rejected result without throwing.

The result contains final text, a typed session handle and the resolved location. An
`outputSchema` implementing Standard Schema and Standard JSON Schema adds an inferred
`output` value. Wrkflw converts it to JSON Schema for the native SDK and validates the
completed value locally before archiving it. The session handle binds the native
harness session ID to its harness, machine and directory. A later turn passes it as
`resume`. Wrkflw rejects a different harness or location before resuming.

Cross-harness steps transfer context through prompt text or files. Separate named runs
retain searchable transcripts but do not inherit context automatically.

`preflight` accepts the same agent option objects as `run`. It checks harness
executables, directories and requested repository isolation without starting an
agent. It collects failures across the supplied list. Workflows invoke preflight
explicitly because arbitrary TypeScript branches cannot be discovered statically.

Normal TypeScript supplies sequencing, fan-out, joins, retries and branching. Wrkflw
does not reproduce those controls in a configuration language.

## SSH boundary

The native driver process boundary uses the system `ssh` client in batch mode.
Login-shell startup makes the remote CLI PATH available. Claude's SDK receives a
custom process spawner. Codex's SDK receives a short-lived local executable shim that
copies any generated output-schema file to a remote temporary path and streams Codex
JSONL through SSH. Neither path needs Wrkflw or Node.js on the remote machine.

The remote machine does not run Wrkflw. It needs:

- non-interactive SSH authentication
- the requested directory
- Git or native jj when the location requests a managed workspace
- the requested agent CLI on the login PATH
- that CLI's authenticated subscription session

Workspace creation, inspection and cleanup use short-lived SSH commands. Remote
workspaces live under `~/.wrkflw/worktrees` unless the remote login environment sets
`WRKFLW_HOME`. Run state and transcripts remain on the machine that started Wrkflw.

## Authentication and permissions

Each CLI uses its login on the machine where it runs. Wrkflw removes
`ANTHROPIC_API_KEY`, `CODEX_API_KEY` and `OPENAI_API_KEY` from harness children so an
inherited API key does not silently replace a subscription login.

Claude Code runs in `bypassPermissions` mode. Codex uses `approvalPolicy: 'never'`
with its `workspace-write` sandbox. The SDKs load each CLI's normal user and project
configuration, including skills and plugins discovered by that CLI. Process location
does not isolate a host like a VM or container. Workflows must use trusted scripts,
targets and repositories.

## Current limits

- there is no central scheduler, resource quota or global concurrency limit
- there is no preference file or implicit model-to-harness routing
- interactive permission approval is not exposed as a Wrkflw command
- run state is local to the machine that started Wrkflw
