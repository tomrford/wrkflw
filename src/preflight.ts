import { executeTarget } from './target-command.js'
import { inspectWorkspaceLocation } from './workspaces.js'
import type { AgentRunOptions, HarnessName, PreflightResult, Target } from './types.js'

const EXECUTABLES: Record<HarnessName, string> = {
  'claude-code': 'claude',
  codex: 'codex',
}

function targetLabel(target: Target): string {
  return target.kind === 'local' ? 'local machine' : target.host
}

async function checkHarness(harness: HarnessName, target: Target): Promise<string> {
  const executable = EXECUTABLES[harness]
  const result = await executeTarget(
    'sh',
    ['-c', 'command -v "$1"', 'wrkflw-preflight', executable],
    undefined,
    target,
  )
  if (result.exitCode !== 0 || result.stdout.trim() === '') {
    throw new Error(`${executable} is not available on ${targetLabel(target)}`)
  }
  return result.stdout.trim()
}

export async function preflightAgents(
  options: ReadonlyArray<AgentRunOptions>,
  workflowCwd: string,
): Promise<Array<PreflightResult>> {
  const harnessChecks = new Map<string, Promise<string>>()
  const locationChecks = new Map<string, ReturnType<typeof inspectWorkspaceLocation>>()
  const checks = options.map(async (agent) => {
    try {
      const location = agent.location ?? agent.resume?.location
      const target = location?.target ?? { kind: 'local' }
      const cwd = location?.cwd ?? workflowCwd
      const harnessKey = JSON.stringify([target, agent.harness])
      let harnessCheck = harnessChecks.get(harnessKey)
      if (harnessCheck === undefined) {
        harnessCheck = checkHarness(agent.harness, target)
        harnessChecks.set(harnessKey, harnessCheck)
      }
      const locationKey = JSON.stringify([target, cwd, location?.worktree === true])
      let locationCheck = locationChecks.get(locationKey)
      if (locationCheck === undefined) {
        locationCheck = inspectWorkspaceLocation({
          cwd,
          target,
          requireRepository: location?.worktree === true,
        })
        locationChecks.set(locationKey, locationCheck)
      }
      const [executable, inspection] = await Promise.all([harnessCheck, locationCheck])
      return {
        id: agent.id,
        harness: agent.harness,
        executable,
        target,
        cwd: inspection.cwd,
        ...(inspection.repository === undefined
          ? {}
          : {
              repositoryKind: inspection.repository.kind,
              repositoryRoot: inspection.repository.root,
            }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Preflight failed for agent ${agent.id}: ${message}`, {
        cause: error,
      })
    }
  })
  const settled = await Promise.allSettled(checks)
  const failures = settled.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `${failures.length} preflight check${failures.length === 1 ? '' : 's'} failed`,
    )
  }
  return settled.map((result) =>
    result.status === 'fulfilled' ? result.value : (undefined as never),
  )
}
