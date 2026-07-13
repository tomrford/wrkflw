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
