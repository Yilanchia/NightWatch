import { mkdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { collectAll, type Runner } from './collect.js'
import { observationStatus, overallStatus, statusLabel } from './health.js'
import { diffFacts, diffSnapshot } from './rules.js'
import { renderReport } from './report.js'
import type { Baseline, Fact, Finding, Observation, ObservationStatus } from './types.js'
import type { WatchConfig, WatchContext } from './tools.js'

/**
 * The inspection pipeline, independent of DSH.
 *
 * collect -> persist -> rules -> status review -> report. A scheduled task or the CLI calls
 * this directly; the agent tools are a thin adapter over the same function. No session, no
 * model, no network: if this cannot run, the product does not exist.
 */

/** Ids only need to be unique within this process; the log keeps every update as its own event. */
let updateSeq = 0
let eventSeq = 0

export function localDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function collectorConfig(config: WatchConfig) {
  return {
    ports: config.ports,
    ssh: config.ssh,
    backup: config.backup,
    backupPaths: config.backupPaths,
    ...(config.sshdConfig ? { sshdConfig: config.sshdConfig } : {}),
    ...(config.authorizedKeys ? { authorizedKeys: config.authorizedKeys } : {}),
  }
}

export interface InspectionOptions {
  readonly now?: number
  readonly platform?: NodeJS.Platform
  readonly runner?: Runner
  /** What asked for this run: `tick`, `report`, `diff`, `baseline`. Recorded in the result. */
  readonly trigger?: string
}

export interface InspectionResult {
  readonly runId: string
  readonly at: number
  readonly host: string
  readonly trigger: string
  /** Health of this run: worst of its collectors. */
  readonly health: ObservationStatus
  readonly observations: readonly Observation[]
  /** Collectors that did not read fully, as human-readable labels. */
  readonly blindSpots: readonly string[]
  /** What the report had to say it could not judge. */
  readonly notes: readonly string[]
  readonly newFindings: readonly Finding[]
  readonly openFindings: readonly Finding[]
  /** Findings confirmed gone in this run (only after a successful read). */
  readonly resolved: readonly Finding[]
  readonly reportPath: string
  readonly reportDay: string
}

function blindSpotLabels(observations: readonly Observation[]): string[] {
  return observations
    .filter((observation) => observationStatus(observation) !== 'ok')
    .map((observation) => `${observation.collector}（${statusLabel(observationStatus(observation))}）`)
}

function judgementNotes(observations: readonly Observation[], baseline: Baseline | undefined): string[] {
  const notes: string[] = []
  if (observations.length === 0) notes.push('没有启用任何采集项')
  const ports = observations.find((observation) => observation.collector === 'ports')
  if (ports && observationStatus(ports) === 'ok' && !baseline) {
    notes.push('还没有基线，端口变化未评估')
  }
  return notes
}

function at(ctx: WatchContext): number {
  return ctx.now ? ctx.now() : Date.now()
}

/** Which collector can prove a finding still exists, or that it is gone. */
function collectorOf(kind: string): string | undefined {
  if (kind === 'new_listen_port' || kind === 'listen_scope_expanded') return 'ports'
  if (kind.startsWith('ssh_')) return 'ssh'
  if (kind.startsWith('backup_')) return 'backup'
  return undefined
}

function readOk(observations: readonly Observation[], kind: string): boolean {
  const collector = collectorOf(kind)
  if (!collector) return false
  const observation = observations.find((candidate) => candidate.collector === collector)
  return observation !== undefined && observationStatus(observation) === 'ok'
}

/** Still true: the rule restated it, or the same fact is still in the latest read and still bad. */
function stillPresent(finding: Finding, currentKeys: ReadonlySet<string>, latest: Map<string, Observation>): boolean {
  if (currentKeys.has(finding.key)) return true
  const collector = collectorOf(finding.kind)
  const observation = collector ? latest.get(collector) : undefined
  if (!observation) return false
  const fact = observation.facts.find((candidate) => candidate.key === finding.key)
  if (!fact) return false
  switch (finding.kind) {
    case 'ssh_password_authentication':
    case 'ssh_empty_password':
      return fact.value.toLowerCase() === 'yes'
    case 'ssh_root_login':
      return /^yes$/i.test(fact.value.trim())
    default:
      return true
  }
}

function collectInto(ctx: WatchContext, now: number, options: InspectionOptions = {}): Observation[] {
  const observations = collectAll(collectorConfig(ctx.config), {
    ...((options.platform ?? ctx.platform) ? { platform: options.platform ?? ctx.platform } : {}),
    ...((options.runner ?? ctx.runner) ? { runner: options.runner ?? ctx.runner } : {}),
    now,
  })
  for (const observation of observations) ctx.store.append(observation)
  return observations
}

/** One full pass: read the machine, write evidence, apply rules, write the day's report. */
export function runInspection(ctx: WatchContext, options: InspectionOptions = {}): InspectionResult {
  const now = options.now ?? at(ctx)
  const observations = collectInto(ctx, now, options)

  const latest = ctx.store.latestObservations()
  const baseline = ctx.store.latestBaseline()
  const findings = diffSnapshot(baseline, latest, { at: now, backupStaleHours: ctx.config.backupStaleHours })
  const openBefore = ctx.store.openFindings()
  const currentKeys = new Set(findings.map((finding) => finding.key))
  const fresh: Finding[] = []

  // New or recurring: a key that is not open right now becomes a finding of its own.
  for (const finding of findings) {
    if (openBefore.some((open) => open.key === finding.key)) continue
    const previous = ctx.store.findings("key = ? AND status IN ('fixed', 'invalid')", finding.key)[0]
    const recorded: Finding = {
      ...finding,
      firstSeen: now,
      lastSeen: now,
      lastChecked: now,
      ...(previous ? { recurrenceOf: previous.id } : {}),
    }
    ctx.store.append(recorded)
    fresh.push(recorded)
  }

  // Sustained or resolved: only a successful read of that collector may update or close a finding.
  const resolved: Finding[] = []
  for (const open of openBefore) {
    if (!readOk(observations, open.kind)) continue
    if (currentKeys.has(open.key) || stillPresent(open, currentKeys, latest)) {
      ctx.store.append({
        type: 'finding-update',
        id: `fupd-${now.toString(36)}-${updateSeq++}`,
        at: now,
        findingId: open.id,
        lastSeen: now,
        lastChecked: now,
      })
    } else {
      ctx.store.append({
        type: 'finding-update',
        id: `fupd-${now.toString(36)}-${updateSeq++}`,
        at: now,
        findingId: open.id,
        status: 'fixed',
        lastChecked: now,
        resolvedAt: now,
      })
      resolved.push({ ...open, status: 'fixed', lastChecked: now, resolvedAt: now })
    }
  }

  const host = observations[0]?.host ?? hostname()
  const health = overallStatus(observations)
  const blindSpots = blindSpotLabels(observations)
  const notes = judgementNotes(observations, baseline)
  const openFindings = ctx.store.openFindings()
  const day = localDay(now)

  const text = renderReport({
    day,
    at: now,
    host,
    ...(baseline ? { baseline } : {}),
    observations: latest,
    findings: fresh,
    openFindings,
    ...(resolved.length > 0 ? { resolved } : {}),
    blindSpots,
    notes,
  })

  mkdirSync(ctx.config.reportDir, { recursive: true })
  const reportPath = join(ctx.config.reportDir, `${day}.md`)
  writeFileSync(reportPath, text, 'utf8')
  ctx.store.append({ type: 'report', id: `report-${now.toString(36)}-${eventSeq++}`, at: now, path: reportPath })

  return {
    runId: `run-${now.toString(36)}`,
    at: now,
    host,
    trigger: options.trigger ?? 'tick',
    health,
    observations,
    blindSpots,
    notes,
    newFindings: fresh,
    openFindings,
    resolved,
    reportPath,
    reportDay: day,
  }
}

/** CLI-facing one-liner, no report parsing needed. */
export function formatInspection(result: InspectionResult): string {
  const parts = [
    `巡检 ${result.reportDay}：采集健康 ${statusLabel(result.health)}`,
    `今日新增 ${result.newFindings.length} 条`,
    `未关闭 ${result.openFindings.length} 条`,
  ]
  if (result.resolved.length > 0) parts.push(`已恢复 ${result.resolved.length} 条`)
  if (result.blindSpots.length > 0) parts.push(`盲区 ${result.blindSpots.join('、')}`)
  if (result.notes.length > 0) parts.push(result.notes.join('；'))
  parts.push(`日报 ${result.reportPath}`)
  return parts.join(' | ')
}

function factSummary(facts: readonly Fact[]): string {
  const byKind = new Map<string, number>()
  for (const fact of facts) byKind.set(fact.kind, (byKind.get(fact.kind) ?? 0) + 1)
  if (byKind.size === 0) return '0 条事实'
  return [...byKind.entries()].map(([kind, count]) => `${kind} ${count} 条`).join('，')
}

/** Take a baseline: what "the way it was" means from now on. A deliberate owner action. */
export function takeBaseline(ctx: WatchContext): string {
  const now = at(ctx)
  const observations = collectInto(ctx, now)
  if (observations.length === 0) {
    return '没有启用任何采集项，基线是空的。先在配置里打开 ports / ssh / backup，再试。'
  }
  const facts = observations.flatMap((observation) => observation.facts)
  const baseline: Baseline = {
    type: 'baseline',
    id: `base-${now.toString(36)}-${eventSeq++}`,
    at: now,
    host: observations[0]?.host ?? hostname(),
    facts,
    observationIds: observations.map((observation) => observation.id),
  }
  ctx.store.append(baseline)
  const ports = facts.filter((fact) => fact.kind === 'listen_port').length
  return `已记录基线（${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}）：${factSummary(facts)}。其中监听端口 ${ports} 个。之后的变化都以它为参照。`
}

/** Compare what is true now with the latest baseline; record only findings not already open. */
export function takeDiff(ctx: WatchContext): string {
  const now = at(ctx)
  const observations = collectInto(ctx, now)
  const latest = ctx.store.latestObservations()
  if (latest.size === 0) return '这次什么也没采到，先看看采集项和权限。'

  const baseline = ctx.store.latestBaseline()
  const findings = diffSnapshot(baseline, latest, { at: now, backupStaleHours: ctx.config.backupStaleHours })
  const open = ctx.store.openFindingKeys()
  const fresh = findings.filter((finding) => !open.has(finding.key))
  for (const finding of fresh) ctx.store.append(finding)

  const before = baseline?.facts ?? []
  const after = [...latest.values()].flatMap((observation) => observation.facts)
  const { added, removed } = diffFacts(before, after)
  const unread = observations
    .filter((observation) => observationStatus(observation) !== 'ok')
    .map((observation) => observation.collector)

  const lines: string[] = []
  if (!baseline) lines.push('还没有基线，端口变化不判定。先 `watch_baseline`，下次起就有"和什么比"了。')
  lines.push(`这次采到 ${observations.length} 个采集项、${after.length} 条事实。`)
  if (added.length > 0) lines.push(`新增：${added.map((fact) => fact.key).join('、')}`)
  if (removed.length > 0 && unread.length === 0) lines.push(`消失：${removed.map((fact) => fact.key).join('、')}`)
  if (removed.length > 0 && unread.length > 0) {
    lines.push(`有采集没读全（${unread.join('、')}），不把没读到当成"消失"。`)
  }
  if (fresh.length === 0) {
    lines.push('没有新发现。')
  } else {
    lines.push(`新发现 ${fresh.length} 条：`)
    for (const finding of fresh) lines.push(`- [${finding.severity}] ${finding.title}（${finding.epistemic === 'observed' ? '读到' : '推断'}）：${finding.detail}`)
  }
  return lines.join('\n')
}

function dayBounds(day: string): { start: number; end: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) throw new Error(`日期要写成 YYYY-MM-DD，收到的是 ${day}`)
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
  return { start, end: new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1).getTime() }
}

/**
 * Write the daily Markdown page. Asking for today's report runs the full inspection pipeline
 * first (collect -> persist -> rules -> status review -> report), so a first request cannot miss
 * a risk that is present right now. A past day is rendered from what was recorded, never filled
 * with today's reading.
 */
export function writeReport(ctx: WatchContext, day?: string): string {
  const now = at(ctx)
  const target = day ?? localDay(now)

  if (target === localDay(now)) {
    const result = runInspection(ctx, { now, trigger: 'report' })
    return `日报已写到 ${result.reportPath}（今日新增 ${result.newFindings.length} 条，未关闭 ${result.openFindings.length} 条，采集${statusLabel(result.health)}）。`
  }

  const { end } = dayBounds(target)
  const findings = ctx.store.findings('at < ? AND (resolved_at IS NULL OR resolved_at >= ?)', end, end)
  const latest = ctx.store.observationsBefore(end)
  const baseline = ctx.store.baselineBefore(end)
  const host = latest.values().next().value?.host ?? hostname()
  const text = renderReport({
    day: target,
    at: now,
    host,
    ...(baseline ? { baseline } : {}),
    observations: latest,
    findings,
    notes: ['历史日报：只按已有记录生成，不重新采集，也不拿今天的状态补过去'],
  })

  mkdirSync(ctx.config.reportDir, { recursive: true })
  const path = join(ctx.config.reportDir, `${target}.md`)
  writeFileSync(path, text, 'utf8')
  ctx.store.append({ type: 'report', id: `report-${now.toString(36)}-${eventSeq++}`, at: now, path })

  const high = findings.filter((finding) => finding.severity === 'high').length
  return `日报已写到 ${path}（${findings.length} 条发现，其中高危 ${high} 条）。`
}
