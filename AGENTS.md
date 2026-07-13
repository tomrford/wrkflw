# Wrkflw contributor guide

Wrkflw is a TypeScript library and agent-first CLI for code-defined workflows across
Claude Code, Codex CLI and Cursor Agent.

## Development

- use the pinned pnpm version and Node.js 22 or newer
- run `pnpm check` before handoff; it covers format, lint, types, tests, docs and build
- keep model IDs exact and keep harness, reasoning and location as separate choices
- keep workflow control flow in TypeScript rather than adding a configuration format
- preserve conservative Git cleanup and bookmark jj work before forgetting a workspace
- use Conventional Commit messages
- publish GitHub releases through `.github/workflows/publish.yml`; npm trusts that
  workflow through OIDC, so do not add an npm token secret

## Architecture

- each named run owns one detached worker; there is no permanent daemon
- after bootstrap, that worker is the sole writer of its state, events and transcripts
- `Location` selects the machine, directory and optional managed workspace
- SSH targets use short-lived OpenSSH processes and need no remote Wrkflw install
- transcripts are normalised for search while raw AG-UI events remain available
- `wrkflw skill` is the agent-facing API contract

## Documentation

Keep documentation in the present tense. Update `README.md`, `docs/architecture.md`
and `src/skill.ts` together when behavior changes. `examples/basic.workflow.ts` and
the embedded README example must match `workflowExample` from `src/skill.ts`.
