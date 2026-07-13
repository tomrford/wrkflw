import type { AgentRunOptions, Workflow } from '../../src/index.js'

const workflow: Workflow = async ({ args, run }) => {
  const input = args[0]
  if (input === undefined) throw new Error('Pass one JSON AgentRunOptions argument')
  return run(JSON.parse(input) as AgentRunOptions)
}

export default workflow
