import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { applyProposal } from './apply.js'
import type { Runner } from './collect.js'
import { takeBaseline, takeDiff, writeReport } from './inspect.js'
import { buildProposal, formatProposal } from './propose.js'
import type { WatchStore } from './store.js'

/**
 * The DSH adapter. It owns no inspection logic: every tool here is a thin wrapper over the
 * pipeline in `inspect.ts`, so the same functions run from the CLI with no session and no model.
 * Keeping this file free of business rules is what lets the core stay framework-independent.
 */

export interface WatchConfig {
  readonly evidencePath: string
  readonly databasePath: string
  readonly reportDir: string
  readonly ports: boolean
  readonly ssh: boolean
  readonly backup: boolean
  readonly backupPaths: readonly string[]
  readonly backupStaleHours: number
  /** Register the repair executor. Defaults to false when absent. */
  readonly applyFix?: boolean
  readonly sshdConfig?: string
  readonly authorizedKeys?: string
}

export interface WatchContext {
  readonly store: WatchStore
  readonly config: WatchConfig
  readonly runner?: Runner
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
}

function at(ctx: WatchContext): number {
  return ctx.now ? ctx.now() : Date.now()
}

/** Write a repair plan for one finding. The plan is stored; nothing on the system changes. */
export function proposeFix(ctx: WatchContext, query: { findingId?: string; key?: string }): string {
  const now = at(ctx)
  const finding = query.findingId
    ? ctx.store.findings('id = ?', query.findingId)[0]
    : query.key
      ? ctx.store.findings("key = ? AND status IN ('candidate', 'verified')", query.key)[0]
      : undefined

  if (!finding) {
    const open = ctx.store.openFindings().slice(0, 5)
    if (open.length === 0) return '没有可提案的发现。先跑一次 watch_diff。'
    return `没找到那条发现。最近的几条是：\n${open.map((entry) => `- ${entry.id} [${entry.severity}] ${entry.title}`).join('\n')}`
  }

  const proposal = buildProposal(finding, now)
  ctx.store.append(proposal)
  return formatProposal(proposal)
}

function defaultSshdConfig(platform: NodeJS.Platform): string {
  return platform === 'win32' ? join(process.env.ProgramData ?? 'C:\\ProgramData', 'ssh', 'sshd_config') : '/etc/ssh/sshd_config'
}

/** Apply one stored plan. The guard has already asked the owner; a refusal never reaches here. */
export function applyFix(ctx: WatchContext, proposalId: string): string {
  const proposal = ctx.store.proposalById(proposalId)
  if (!proposal) return `没有找到提案 ${proposalId}。先 watch_propose_fix，让它先给出计划。`
  const platform = ctx.platform ?? process.platform
  const sshdConfig = ctx.config.sshdConfig ?? defaultSshdConfig(platform)
  return applyProposal(ctx.store, proposal, { sshdConfig, now: at(ctx) })
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export function registerTools(ctx: Context, watch: WatchContext): void {
  ctx.tools.register(
    defineTool({
      name: 'watch_baseline',
      description:
        'Take a read-only baseline of the machine (listening ports, SSH configuration, backup age). Later diffs compare against it. Nothing is changed on the system.',
      parameters: {},
      output: TEXT_OUTPUT,
      async execute() {
        return takeBaseline(watch)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'watch_diff',
      description:
        'Collect the machine again, compare with the latest baseline, and record findings (new listening ports, weak SSH settings, stale backups). Read-only; every finding points at the observation it came from.',
      parameters: {},
      output: TEXT_OUTPUT,
      async execute() {
        return takeDiff(watch)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'watch_report',
      description:
        'Write the daily Markdown report for a day (default: today) into the report folder and return its path plus a one-line summary. Asking for today runs a full inspection first.',
      parameters: {
        day: { type: 'string', description: 'Day to report on, as YYYY-MM-DD. Defaults to today.' },
      },
      output: TEXT_OUTPUT,
      async execute({ day }: { day?: string }) {
        return writeReport(watch, day)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'watch_propose_fix',
      description:
        'Write a repair plan for one finding: what would change, the risk, how to roll it back and how to verify it. It never changes the system; applying a plan is a separate step that needs the owner and does not exist in this version.',
      parameters: {
        findingId: { type: 'string', description: 'Finding id shown by watch_diff or watch_report.' },
        key: { type: 'string', description: 'Or the finding key, e.g. ssh:passwordauthentication.' },
      },
      output: TEXT_OUTPUT,
      async execute({ findingId, key }: { findingId?: string; key?: string }) {
        return proposeFix(watch, { ...(findingId ? { findingId } : {}), ...(key ? { key } : {}) })
      },
    }),
  )

  // The executor is opt-in. A read-only watcher should not even expose a repair key by default.
  if (watch.config.applyFix) ctx.tools.register(
    defineTool({
      name: 'watch_apply_fix',
      description:
        'Apply one stored repair plan to the SSH config. Destructive: the owner is asked to approve it first and a refusal wins. The original file is copied first, every changed line is verified, a failure restores the copy, and no service is restarted.',
      parameters: {
        proposalId: { type: 'string', required: true, description: 'Proposal id returned by watch_propose_fix.' },
      },
      output: TEXT_OUTPUT,
      async execute({ proposalId }: { proposalId: string }) {
        return applyFix(watch, proposalId)
      },
    }),
  )
}
