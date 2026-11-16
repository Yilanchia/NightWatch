import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyProposal } from './apply.js'
import { consumeGrant, findGrant, loadApprovalKey, stateFingerprint, verifyGrant } from './approval.js'
import { appendJudgment, validateJudgment, type JudgmentInput } from './judgment.js'
import type { Runner } from './collect.js'
import { formatHealth, inspectionHealth, takeBaseline, takeDiff, writeReport } from './inspect.js'
import { buildProposal, formatProposal } from './propose.js'
import type { WatchStore } from './store.js'
import { timelineText } from './timeline.js'

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
  /** How long a successful read stays usable; older data is reported as stale. Defaults to 26. */
  readonly observationValidHours?: number
  /** Register the repair executor. Defaults to false when absent. */
  readonly applyFix?: boolean
  /** Require a one-time owner approval grant before the executor writes. Defaults to true. */
  readonly requireApproval?: boolean
  /** Where structured investigation judgments are appended. Defaults next to the evidence log. */
  readonly judgmentsPath?: string
  /** Model label recorded on judgments; the anchor of "source:model". */
  readonly modelLabel?: string
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

/** Apply one stored plan, but only with a valid, unconsumed owner approval grant. */
export function applyFix(ctx: WatchContext, proposalId: string, approvalId?: string): string {
  const proposal = ctx.store.proposalById(proposalId)
  if (!proposal) return `没有找到提案 ${proposalId}。先 watch_propose_fix，让它先给出计划。`
  const platform = ctx.platform ?? process.platform
  const sshdConfig = ctx.config.sshdConfig ?? defaultSshdConfig(platform)
  const now = at(ctx)

  if (ctx.config.requireApproval !== false) {
    const home = dirname(ctx.config.evidencePath)
    if (!approvalId) {
      return `不执行：这份提案需要主人审批。先运行 \`nightwatch approve ${home} ${proposalId}\`，再把审批 ID 交给执行器。`
    }
    const key = loadApprovalKey(home)
    if (!key) return '不执行：这台机器还没有审批密钥。先运行 nightwatch approve 生成审批。'
    const grant = findGrant(home, approvalId)
    if (!grant) return `不执行：找不到审批 ${approvalId}。`
    let current: string
    try {
      current = readFileSync(sshdConfig, 'utf8')
    } catch {
      return `不执行：读不到 ${sshdConfig}，无法核对审批绑定的文件状态。`
    }
    const check = verifyGrant(grant, key.publicKeyPem, {
      proposal,
      stateFingerprint: stateFingerprint(current),
      now,
    })
    if (!check.ok) return `不执行：审批无效（${check.reason ?? '未知原因'}）。`
    if (!consumeGrant(home, grant.id, now)) return '不执行：这是一次性审批，已经被使用过。'
  }

  return applyProposal(ctx.store, proposal, { sshdConfig, now, ...(approvalId ? { approvalId } : {}) })
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

function parseJsonArray(raw: string | undefined, name: string): unknown[] {
  if (!raw) return []
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) throw new Error(`${name} 必须是 JSON 数组`)
  return parsed
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

  ctx.tools.register(
    defineTool({
      name: 'watch_health',
      description:
        'Answer when the last inspection ran, when it last read everything successfully, which collectors are blind or stale, and what is still open. Read-only.',
      parameters: {},
      output: TEXT_OUTPUT,
      async execute() {
        return formatHealth(inspectionHealth(watch.store, watch.config, at(watch)))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'watch_timeline',
      description:
        'Show one fact over a time window: reads, the finding it produced, confirmations and resolution, plus any gap where the check did not run. Read-only.',
      parameters: {
        key: { type: 'string', required: true, description: 'Fact key, e.g. tcp:3306 or ssh:passwordauthentication.' },
        days: { type: 'number', description: 'How far back to look, in days. Defaults to 7.' },
      },
      output: TEXT_OUTPUT,
      async execute({ key, days }: { key: string; days?: number }) {
        return timelineText(watch.store, key, days ?? 7, at(watch))
      },
    }),
  )

  // The model's only write: a structured judgment about one finding, written to a separate file.
  // Registered only when a judgments path is configured (analyst), so the minimal host's surface
  // stays exactly the read-only watch_* set.
  if (watch.config.judgmentsPath) ctx.tools.register(
    defineTool({
      name: 'watch_investigate_judgment',
      description:
        'Record a structured investigation judgment about one finding. confirmed[] must cite real observation ids; candidates[] are inferences with likelihood; counter[] must contain counter-evidence you actually looked for; gaps[] are what you could not see. This never changes findings, baselines or policy.',
      parameters: {
        findingId: { type: 'string', required: true, description: 'Finding id from watch_diff or watch_report.' },
        confirmed: { type: 'string', description: 'JSON array of {text, evidenceRef} where evidenceRef is an observation id.' },
        candidates: { type: 'string', description: 'JSON array of {text, likelihood: low|medium|high}.' },
        counter: { type: 'string', description: 'JSON array of counter-evidence strings.' },
        gaps: { type: 'string', description: 'JSON array of what could not be observed.' },
        recommendation: { type: 'string', required: true, description: 'What the owner should do; proposals only.' },
        disposition: { type: 'string', required: true, description: 'propose | escalate | benign-pending-owner.' },
        confidence: { type: 'string', required: true, description: 'low | medium | high.' },
        budget: { type: 'string', description: 'Optional JSON {calls,ms,bytes} budget snapshot.' },
      },
      output: TEXT_OUTPUT,
      async execute(args: {
        findingId: string
        confirmed?: string
        candidates?: string
        counter?: string
        gaps?: string
        recommendation: string
        disposition: string
        confidence: string
        budget?: string
      }) {
        const finding = watch.store.findings('id = ?', args.findingId)[0]
        if (!finding) return `拒绝：没有找到发现 ${args.findingId}`
        let input: JudgmentInput
        try {
          input = {
            confirmed: parseJsonArray(args.confirmed, 'confirmed') as JudgmentInput['confirmed'],
            candidates: parseJsonArray(args.candidates, 'candidates') as JudgmentInput['candidates'],
            counter: parseJsonArray(args.counter, 'counter') as string[],
            gaps: parseJsonArray(args.gaps, 'gaps') as string[],
            recommendation: args.recommendation,
            disposition: args.disposition as JudgmentInput['disposition'],
            confidence: args.confidence as JudgmentInput['confidence'],
          }
        } catch (error) {
          return `拒绝：${error instanceof Error ? error.message : String(error)}`
        }
        let budget = { calls: 0, ms: 0, bytes: 0 }
        if (args.budget) {
          try {
            budget = JSON.parse(args.budget) as typeof budget
          } catch {
            return '拒绝：budget 必须是 JSON 对象'
          }
        }
        const result = validateJudgment(input, {
          finding,
          observationExists: (id) => watch.store.observationById(id) !== undefined,
          now: at(watch),
          model: watch.config.modelLabel ?? 'model',
          budget,
        })
        if (!result.ok || !result.judgment) return `拒绝：${result.errors.join('；')}`
        const path = watch.config.judgmentsPath ?? join(dirname(watch.config.evidencePath), 'judgments.jsonl')
        appendJudgment(path, result.judgment)
        return `已记录调查判断 ${result.judgment.id}（source=model，confidence=${result.judgment.confidence}）；发现/基线/策略未改动。`
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
        approvalId: { type: 'string', description: 'One-time owner approval id returned by nightwatch approve.' },
      },
      output: TEXT_OUTPUT,
      async execute({ proposalId, approvalId }: { proposalId: string; approvalId?: string }) {
        return applyFix(watch, proposalId, approvalId)
      },
    }),
  )
}
