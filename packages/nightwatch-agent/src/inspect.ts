import { mkdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { collectAll, type Runner } from './collect.js'
import { observationStatus, overallStatus, statusLabel } from './health.js'
import { diffFacts, diffSnapshot, factExposure } from './rules.js'
import { renderReport } from './report.js'
import type { WatchStore } from './store.js'
import { localDay, localStamp } from './time.js'
import type { Baseline, Fact, Finding, Observation, ObservationStatus, RunEvent } from './types.js'
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

export { localDay }

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
  /** Findings that stopped differing from the baseline because the owner accepted a new baseline. */
  readonly invalidated: readonly Finding[]
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

/** A failed read does not make yesterday's success current; say how old the usable data is. */
function stalenessNotes(ctx: WatchContext, observations: readonly Observation[], now: number): string[] {
  const hours = ctx.config.observationValidHours ?? 26
  const notes: string[] = []
  for (const observation of observations) {
    if (observationStatus(observation) === 'ok') continue
    const lastOk = ctx.store.lastOkAt(observation.collector)
    if (lastOk === undefined) continue
    const ageHours = (now - lastOk) / 3_600_000
    if (ageHours > hours) {
      notes.push(`${observation.collector} 上次成功是 ${Math.round(ageHours)} 小时前，数据已过期（阈值 ${hours} 小时）`)
    }
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

type Verdict = 'present' | 'fixed' | 'invalid'

/**
 * What an open finding looks like now.
 * - present: the rule restated it, or the bad fact is still there;
 * - fixed: the condition is gone (port closed, key removed, setting changed);
 * - invalid: the condition stopped differing from the baseline because the owner accepted a new
 *   baseline. That is not a repair and must not be reported as one.
 */
function classifyFinding(
  finding: Finding,
  currentKeys: ReadonlySet<string>,
  latest: Map<string, Observation>,
  baseline: Baseline | undefined,
): Verdict {
  if (currentKeys.has(finding.key)) return 'present'
  const collector = collectorOf(finding.kind)
  const observation = collector ? latest.get(collector) : undefined
  if (!observation) return 'present'
  const fact = observation.facts.find((candidate) => candidate.key === finding.key)
  const baselineFact = baseline?.facts.find((candidate) => candidate.key === finding.key)

  switch (finding.kind) {
    case 'ssh_password_authentication':
    case 'ssh_empty_password':
      if (!fact) return 'fixed'
      return fact.value.toLowerCase() === 'yes' ? 'present' : 'fixed'
    case 'ssh_root_login':
      if (!fact) return 'fixed'
      return /^yes$/i.test(fact.value.trim()) ? 'present' : 'fixed'
    case 'listen_scope_expanded':
      if (!fact) return 'fixed' // the port is gone
      if (!baselineFact) return 'present'
      return factExposure(fact) > factExposure(baselineFact) ? 'present' : 'fixed'
    case 'new_listen_port':
      if (!fact) return 'fixed'
      return baselineFact ? 'invalid' : 'present'
    case 'ssh_authorized_key_added':
      if (!fact) return 'fixed'
      return baselineFact ? 'invalid' : 'present'
    default:
      // backup_*: the condition is the fact itself; if the rule did not restate it, it is gone.
      return 'fixed'
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

  // Sustained, repaired, or absorbed by a new baseline. Only a successful read may decide.
  const resolved: Finding[] = []
  const invalidated: Finding[] = []
  for (const open of openBefore) {
    if (!readOk(observations, open.kind)) continue
    const verdict = classifyFinding(open, currentKeys, latest, baseline)
    if (verdict === 'present') {
      ctx.store.append({
        type: 'finding-update',
        id: `fupd-${now.toString(36)}-${updateSeq++}`,
        at: now,
        findingId: open.id,
        lastSeen: now,
        lastChecked: now,
      })
      continue
    }
    ctx.store.append({
      type: 'finding-update',
      id: `fupd-${now.toString(36)}-${updateSeq++}`,
      at: now,
      findingId: open.id,
      status: verdict,
      lastChecked: now,
      resolvedAt: now,
    })
    const closed: Finding = { ...open, status: verdict, lastChecked: now, resolvedAt: now }
    if (verdict === 'fixed') resolved.push(closed)
    else invalidated.push(closed)
  }

  const host = observations[0]?.host ?? hostname()
  const health = overallStatus(observations)
  const blindSpots = blindSpotLabels(observations)
  const notes = [...judgementNotes(observations, baseline), ...stalenessNotes(ctx, observations, now)]
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
    ...(invalidated.length > 0 ? { invalidated } : {}),
    blindSpots,
    notes,
  })

  mkdirSync(ctx.config.reportDir, { recursive: true })
  const reportPath = join(ctx.config.reportDir, `${day}.md`)
  writeFileSync(reportPath, text, 'utf8')
  ctx.store.append({ type: 'report', id: `report-${now.toString(36)}-${eventSeq++}`, at: now, path: reportPath })

  const trigger = options.trigger ?? 'tick'
  const runId = `run-${now.toString(36)}-${eventSeq++}`
  ctx.store.append({
    type: 'run',
    id: runId,
    at: now,
    trigger,
    health,
    blindSpots,
    notes,
    reportPath,
  })

  return {
    runId,
    at: now,
    host,
    trigger,
    health,
    observations,
    blindSpots,
    notes,
    newFindings: fresh,
    openFindings,
    resolved,
    invalidated,
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
  if (result.invalidated.length > 0) parts.push(`已失效（纳入基线）${result.invalidated.length} 条`)
  if (result.blindSpots.length > 0) parts.push(`盲区 ${result.blindSpots.join('、')}`)
  if (result.notes.length > 0) parts.push(result.notes.join('；'))
  parts.push(`日报 ${result.reportPath}`)
  return parts.join(' | ')
}

export interface CollectorHealth {
  readonly name: string
  readonly lastStatus?: ObservationStatus
  readonly lastOkAt?: number
  readonly ageHours?: number
}

export interface HealthSummary {
  readonly now: number
  readonly lastRun?: RunEvent
  readonly lastOkRun?: RunEvent
  readonly collectors: readonly CollectorHealth[]
  /** Collectors whose last success is older than the validity window. */
  readonly stale: readonly string[]
  readonly blindSpots: readonly string[]
  /** Checks that are enabled but cannot run yet, e.g. backup without a path. */
  readonly skipped: readonly string[]
}

/** "When did it last work, what didn't we read, and is the data still usable." */
export function inspectionHealth(store: WatchStore, config: WatchConfig, now: number): HealthSummary {
  const latest = store.latestObservations()
  const validHours = config.observationValidHours ?? 26
  const enabled: string[] = []
  const skipped: string[] = []
  if (config.ports) enabled.push('ports')
  if (config.ssh) enabled.push('ssh')
  if (config.backup && config.backupPaths.length > 0) enabled.push('backup')
  if (config.backup && config.backupPaths.length === 0) skipped.push('backup（没有配置 backupPaths）')

  const collectors: CollectorHealth[] = enabled.map((name) => {
    const lastOkAt = store.lastOkAt(name)
    const latestObservation = latest.get(name)
    const lastStatus = latestObservation ? observationStatus(latestObservation) : undefined
    const ageHours = lastOkAt !== undefined ? (now - lastOkAt) / 3_600_000 : undefined
    return {
      name,
      ...(lastStatus ? { lastStatus } : {}),
      ...(lastOkAt !== undefined ? { lastOkAt } : {}),
      ...(ageHours !== undefined ? { ageHours: Math.round(ageHours) } : {}),
    }
  })

  const stale = collectors
    .filter((item) => item.lastStatus !== 'ok' && item.ageHours !== undefined && item.ageHours > validHours)
    .map((item) => `${item.name}（上次成功 ${item.ageHours} 小时前）`)

  const lastRun = store.lastRun()
  const lastOkRun = store.lastOkRun()
  return {
    now,
    ...(lastRun ? { lastRun } : {}),
    ...(lastOkRun ? { lastOkRun } : {}),
    collectors,
    stale,
    blindSpots: lastRun?.blindSpots ?? [],
    skipped,
  }
}

export function formatHealth(summary: HealthSummary): string {
  const lines: string[] = []
  lines.push(`巡检健康（${localStamp(summary.now)}）`)
  lines.push('')
  lines.push(`最近一轮：${summary.lastRun ? `${localStamp(summary.lastRun.at)} · ${summary.lastRun.trigger} · ${statusLabel(summary.lastRun.health)}` : '还没有任何巡检记录'}`)
  lines.push(`最近成功：${summary.lastOkRun ? `${localStamp(summary.lastOkRun.at)}（${summary.lastOkRun.trigger}）` : '还没有一轮是全绿'}`)
  if (summary.blindSpots.length > 0) lines.push(`最近盲区：${summary.blindSpots.join('、')}`)
  if (summary.stale.length > 0) lines.push(`数据过期：${summary.stale.join('、')}`)
  if (summary.skipped.length > 0) lines.push(`未运行：${summary.skipped.join('、')}`)
  lines.push('')
  for (const collector of summary.collectors) {
    const status = collector.lastStatus ? statusLabel(collector.lastStatus) : '从未读到'
    const lastOk = collector.lastOkAt ? localStamp(collector.lastOkAt) : '无'
    lines.push(`- ${collector.name}：当前 ${status}；上次成功 ${lastOk}`)
  }
  return lines.join('\n')
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
  const unread = observations.filter((observation) => observationStatus(observation) !== 'ok')
  if (unread.length > 0) {
    const names = unread.map((observation) => `${observation.collector}（${statusLabel(observationStatus(observation))}）`)
    return `基线不完整：${names.join('、')} 没有读全，这次不记录基线。先修采集或等下一次成功——半份基线会让之后的端口和公钥比较失真。`
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
  return `已记录基线（${localStamp(now)}）：${factSummary(facts)}。其中监听端口 ${ports} 个。之后的变化都以它为参照。`
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
