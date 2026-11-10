import { observationStatus, statusLabel } from './health.js'
import { localStamp } from './time.js'
import type { Baseline, Fact, Finding, Observation } from './types.js'

/**
 * The daily page. Plain Markdown, no template engine: it lands in the owner's workspace and in
 * the report folder, and it must read well without a model touching it.
 *
 * Three rules shape this page:
 * - "nothing changed" is only allowed when every collector actually read;
 * - risks that are still open stay listed on later days;
 * - a check that did not run is a blind spot, not a clean bill of health.
 */

export interface ReportInput {
  readonly day: string
  readonly at: number
  readonly host: string
  readonly baseline?: Baseline
  readonly observations: Map<string, Observation>
  /** Findings created today. */
  readonly findings: Finding[]
  /** Findings that are still open (candidate or verified). */
  readonly openFindings?: readonly Finding[]
  /** Findings confirmed gone today, after a successful read. */
  readonly resolved?: readonly Finding[]
  /** Findings absorbed by a new baseline: no longer deviations, but not repairs either. */
  readonly invalidated?: readonly Finding[]
  /** Collectors that did not read fully, e.g. "ports（读取失败）". */
  readonly blindSpots?: readonly string[]
  /** Things the report must say it could not judge, e.g. no baseline for ports. */
  readonly notes?: readonly string[]
}

function severityRank(severity: Finding['severity']): number {
  return severity === 'high' ? 0 : severity === 'medium' ? 1 : 2
}

function sorted(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity))
}

function lineFor(finding: Finding, fresh: boolean): string {
  const tag = fresh ? '（今日新增）' : ''
  return `- **[${finding.severity}] ${finding.title}**${tag}（${finding.epistemic === 'observed' ? '读到' : '推断'}，证据 ${finding.observationId}）\n  ${finding.detail}`
}

export function renderReport(input: ReportInput): string {
  const fresh = sorted(input.findings)
  const open = sorted(input.openFindings ?? [])
  const blindSpots = input.blindSpots ?? []
  const notes = input.notes ?? []
  const freshIds = new Set(fresh.map((finding) => finding.id))
  const high = open.filter((finding) => finding.severity === 'high').length
  const medium = open.filter((finding) => finding.severity === 'medium').length

  const lines: string[] = []
  lines.push(`# 守夜人日报 · ${input.day}`)
  lines.push('')
  lines.push(`机器：${input.host} · 生成于 ${localStamp(input.at)}`)
  lines.push('')

  lines.push('## 一句话')
  lines.push('')
  const sentence: string[] = []
  if (fresh.length > 0) sentence.push(`今日新增 ${fresh.length} 条要看的`)
  if (open.length > 0) sentence.push(`未关闭 ${open.length} 条（高危 ${high} 条，中危 ${medium} 条）`)
  const resolvedCount = (input.resolved ?? []).length
  if (resolvedCount > 0) sentence.push(`已恢复 ${resolvedCount} 条`)
  const invalidatedCount = (input.invalidated ?? []).length
  if (invalidatedCount > 0) sentence.push(`已失效（纳入基线）${invalidatedCount} 条`)
  if (blindSpots.length > 0) sentence.push(`有 ${blindSpots.length} 项没读全：${blindSpots.join('、')}`)
  for (const note of notes) sentence.push(note)
  if (sentence.length === 0) {
    lines.push('今天没有值得单独说的变化。')
  } else {
    lines.push(`${sentence.join('；')}。`)
  }
  lines.push('')

  lines.push('## 未关闭的风险')
  lines.push('')
  if (open.length === 0) {
    lines.push('（无）')
  } else {
    for (const finding of open) lines.push(lineFor(finding, freshIds.has(finding.id)))
  }
  lines.push('')

  if ((input.resolved ?? []).length > 0) {
    lines.push('## 已恢复')
    lines.push('')
    for (const finding of input.resolved ?? []) {
      lines.push(`- **[${finding.severity}] ${finding.title}**（首次 ${localStamp(finding.firstSeen ?? finding.at)}，恢复 ${localStamp(finding.resolvedAt ?? finding.at)}）`)
    }
    lines.push('')
  }

  if ((input.invalidated ?? []).length > 0) {
    lines.push('## 已失效（纳入新基线）')
    lines.push('')
    for (const finding of input.invalidated ?? []) {
      lines.push(`- **[${finding.severity}] ${finding.title}**（首次 ${localStamp(finding.firstSeen ?? finding.at)}，纳入基线 ${localStamp(finding.resolvedAt ?? finding.at)}）`)
    }
    lines.push('')
  }

  lines.push('## 采集健康')
  lines.push('')
  lines.push('| 采集项 | 状态 | 事实数 | 最后采集 | 命令 |')
  lines.push('|---|---|---|---|---|')
  for (const [collector, observation] of [...input.observations.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const status = observationStatus(observation)
    const command = observation.evidence.map((read) => read.command).join('；').replace(/\|/g, '\\|')
    lines.push(`| ${collector} | ${statusLabel(status)} | ${observation.facts.length} | ${localStamp(observation.at)} | ${command} |`)
  }
  if (blindSpots.length > 0) {
    lines.push('')
    lines.push(`**检查盲区**：${blindSpots.join('、')} 没有读全。这些部分今天判不出来，不能当成"没有变化"。`)
    const reasons = [...input.observations.entries()]
      .filter(([, observation]) => observationStatus(observation) !== 'ok' && observation.error !== undefined)
      .map(([name, observation]) => `${name}：${observation.error}`)
    if (reasons.length > 0) lines.push(`原因：${reasons.join('；')}`)
  }
  lines.push('')

  lines.push('## 基线')
  lines.push('')
  if (input.baseline) {
    lines.push(`最近一次基线：${localStamp(input.baseline.at)}，${input.baseline.facts.length} 条事实。`)
  } else {
    lines.push('还没有基线。先跑一次 `watch_baseline`；没有基线时端口变化不判定，避免把"不知道"说成"没变化"。')
  }
  lines.push('')

  lines.push('---')
  lines.push('')
  lines.push('所有事实都是只读采集，命令固定；发现带证据编号，可以在 `watch.jsonl` 里查到原文哈希。')
  lines.push('')
  return lines.join('\n')
}

/** Facts as a short, readable list for tool output (not the report file). */
export function summarizeFacts(facts: readonly Fact[]): string {
  if (facts.length === 0) return '（没有读到事实）'
  return facts.map((fact) => `- ${fact.key} = ${fact.value}`).join('\n')
}
