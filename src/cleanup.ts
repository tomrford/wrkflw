import type { RunStore } from './store.js'
import type { RunWarning } from './types.js'
import { pruneManagedWorkspace } from './workspaces.js'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const WORKSPACE_WARNING_CODES = new Set([
  'workspace-retained',
  'git-branch-retained',
  'workspace-cleanup-failed',
])

async function resolveWorkspaceWarnings(
  store: RunStore,
  runId: string,
  agentId: string,
  path: string,
  codes: ReadonlySet<string> = WORKSPACE_WARNING_CODES,
): Promise<void> {
  const resolvedAt = new Date().toISOString()
  const resolved: Array<RunWarning> = []
  await store.update(runId, (current) => {
    for (const warning of current.warnings) {
      if (
        warning.resolvedAt === undefined &&
        warning.agentId === agentId &&
        warning.path === path &&
        codes.has(warning.code)
      ) {
        warning.resolvedAt = resolvedAt
        resolved.push(warning)
      }
    }
  })
  for (const warning of resolved) {
    await store.event(runId, {
      type: 'workflow.warning-resolved',
      agentId,
      data: warning,
    })
  }
}

async function resolveRunCleanupWarnings(
  store: RunStore,
  runId: string,
): Promise<void> {
  const resolvedAt = new Date().toISOString()
  const resolved: Array<RunWarning> = []
  await store.update(runId, (current) => {
    for (const warning of current.warnings) {
      if (warning.resolvedAt === undefined && warning.code === 'run-cleanup-failed') {
        warning.resolvedAt = resolvedAt
        resolved.push(warning)
      }
    }
  })
  for (const warning of resolved) {
    await store.event(runId, { type: 'workflow.warning-resolved', data: warning })
  }
}

export async function cleanupRunWorkspaces(
  store: RunStore,
  runId: string,
  force = false,
): Promise<Array<RunWarning>> {
  const record = await store.get(runId)
  const warnings: Array<RunWarning> = []

  for (const agent of Object.values(record.agents)) {
    const workspace = agent.workspace
    if (workspace === undefined || workspace.status === 'pruned') continue
    const at = new Date().toISOString()
    try {
      const result = await pruneManagedWorkspace(workspace, force)
      await store.event(runId, {
        type: 'workspace.cleanup',
        agentId: agent.id,
        data: result,
      })
      await store.update(runId, (current) => {
        const stored = current.agents[agent.id]?.workspace
        if (stored === undefined) return
        if (result.branchRetained) stored.status = 'retained'
        else if (result.pruned) {
          stored.status = 'pruned'
          stored.prunedAt = at
        }
        if (result.bookmark !== undefined) stored.bookmark = result.bookmark
        if (result.finalRevision !== undefined) {
          stored.finalRevision = result.finalRevision
        }
      })

      if (!result.pruned) {
        warnings.push({
          code: 'workspace-retained',
          message: result.reason ?? 'Managed workspace needs attention',
          at,
          agentId: agent.id,
          target: workspace.target,
          path: workspace.path,
        })
      } else if (result.branchRetained) {
        await resolveWorkspaceWarnings(
          store,
          runId,
          agent.id,
          workspace.path,
          new Set(['workspace-retained', 'workspace-cleanup-failed']),
        )
        warnings.push({
          code: 'git-branch-retained',
          message: result.reason ?? `Git branch ${result.branch} was retained`,
          at,
          agentId: agent.id,
          target: workspace.target,
          path: workspace.path,
        })
      } else {
        await resolveWorkspaceWarnings(store, runId, agent.id, workspace.path)
      }
    } catch (error) {
      const message = messageOf(error)
      await store.event(runId, {
        type: 'workspace.cleanup-failed',
        agentId: agent.id,
        data: { error: message, workspace },
      })
      warnings.push({
        code: 'workspace-cleanup-failed',
        message,
        at,
        agentId: agent.id,
        target: workspace.target,
        path: workspace.path,
      })
    }
  }

  if (warnings.length > 0) {
    const added: Array<RunWarning> = []
    await store.update(runId, (current) => {
      for (const warning of warnings) {
        const duplicate = current.warnings.some(
          (existing) =>
            existing.resolvedAt === undefined &&
            existing.code === warning.code &&
            existing.agentId === warning.agentId &&
            existing.path === warning.path,
        )
        if (!duplicate) {
          current.warnings.push(warning)
          added.push(warning)
        }
      }
    })
    for (const warning of added) {
      await store.event(runId, {
        type: 'workflow.warning',
        ...(warning.agentId === undefined ? {} : { agentId: warning.agentId }),
        data: warning,
      })
    }
  }
  await resolveRunCleanupWarnings(store, runId)
  return warnings
}
