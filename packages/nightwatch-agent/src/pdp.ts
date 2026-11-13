import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * Policy decision point (PDP), plugin-level prototype.
 *
 * guard judges by tool *name*; the enforcement probe showed a routine-named write is not stopped.
 * This layer instead decides from an explicit action declaration: a tool is allowed only if it
 * declares `operation: 'read'` and needs no approval. Anything else — unknown name, write, network,
 * approval-required — is denied before its body runs. It is fail-closed by construction.
 *
 * Scope: this is still a plugin-level guard. It sees the tool name and arguments; it cannot know
 * what an arbitrary plugin's body will do. That is exactly why unknown tools are denied rather
 * than trusted.
 */

export type Operation = 'read' | 'write' | 'network' | 'note'

export interface ToolAction {
  readonly tool: string
  readonly operation: Operation
  readonly resources: readonly string[]
  readonly approval: 'none' | 'owner'
}

/** The only actions Nightwatch declares today: read-only queries over its own evidence. */
export const WATCH_ACTIONS: Readonly<Record<string, ToolAction>> = {
  watch_baseline: { tool: 'watch_baseline', operation: 'read', resources: ['ports', 'ssh', 'backup'], approval: 'none' },
  watch_diff: { tool: 'watch_diff', operation: 'read', resources: ['ports', 'ssh', 'backup'], approval: 'none' },
  watch_report: { tool: 'watch_report', operation: 'read', resources: ['evidence'], approval: 'none' },
  watch_health: { tool: 'watch_health', operation: 'read', resources: ['evidence'], approval: 'none' },
  watch_timeline: { tool: 'watch_timeline', operation: 'read', resources: ['evidence'], approval: 'none' },
  watch_propose_fix: { tool: 'watch_propose_fix', operation: 'read', resources: ['findings'], approval: 'none' },
  // Registered only when the owner enables it; always needs the owner's approval.
  watch_apply_fix: { tool: 'watch_apply_fix', operation: 'write', resources: ['sshd_config'], approval: 'owner' },
  // Local inference annotations only; never part of the evidence log.
  watch_investigate_note: { tool: 'watch_investigate_note', operation: 'note', resources: ['investigation-notes'], approval: 'none' },
}

export interface PolicyDecision {
  readonly allow: boolean
  readonly reason?: string
}

/** Pure decision, so the gate can be tested without booting a host. */
export function decide(execution: { readonly name: string }, actions: Readonly<Record<string, ToolAction>> = WATCH_ACTIONS): PolicyDecision {
  const action = actions[execution.name]
  if (!action) {
    return { allow: false, reason: `PDP: 未声明动作的工具「${execution.name}」被拒绝（fail-closed）` }
  }
  if (action.operation !== 'read' && action.operation !== 'note') {
    return { allow: false, reason: `PDP: 「${execution.name}」是 ${action.operation} 动作，需要主人审批；当前未实现` }
  }
  if (action.approval !== 'none') {
    return { allow: false, reason: `PDP: 「${execution.name}」需要审批` }
  }
  return { allow: true }
}

export function policyGuard(actions: Readonly<Record<string, ToolAction>> = WATCH_ACTIONS) {
  return (execution: ToolExecution): string | undefined => {
    const decision = decide(execution, actions)
    return decision.allow ? undefined : decision.reason
  }
}

/** Install the PDP as a monotonic guard on the host's tool runtime. */
export function installPolicy(ctx: Context, actions: Readonly<Record<string, ToolAction>> = WATCH_ACTIONS): () => void {
  return ctx.tools.guard(policyGuard(actions))
}
