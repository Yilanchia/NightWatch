import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchStore } from './store.js'
import { localDay, localStamp } from './time.js'

/**
 * Release acceptance: check the evidence actually proves "seven days without lying".
 *
 * It does not rerun collectors; it audits what is already on disk:
 *   1. every one of the last N local days has at least one run record;
 *   2. every one of those days has a report file;
 *   3. the latest run is not `failed`;
 *   4. rebuilding a throwaway copy of `watch.jsonl` yields the same open findings and baseline.
 */

export interface AcceptanceCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export interface AcceptanceResult {
  readonly checks: readonly AcceptanceCheck[]
  readonly pass: boolean
}

export interface AcceptanceOptions {
  readonly now: number
  readonly days?: number
  readonly evidencePath: string
  readonly reportDir?: string
}

const DAY = 86_400_000

export function runAcceptance(store: WatchStore, options: AcceptanceOptions): AcceptanceResult {
  const days = Math.max(1, options.days ?? 7)
  const from = options.now - days * DAY
  const checks: AcceptanceCheck[] = []

  const runs = store.runsSince(from, options.now)
  const daysWithRun = new Set(runs.map((run) => localDay(run.at)))
  const missingDays: string[] = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = localDay(options.now - offset * DAY)
    if (!daysWithRun.has(day)) missingDays.push(day)
  }
  checks.push({
    name: '每日 run 记录',
    ok: missingDays.length === 0,
    detail:
      missingDays.length === 0
        ? `最近 ${days} 天都有 run（共 ${runs.length} 次）`
        : `缺少 run 的日期：${missingDays.join('、')}`,
  })

  if (options.reportDir) {
    const missingReports: string[] = []
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const day = localDay(options.now - offset * DAY)
      if (!existsSync(join(options.reportDir, `${day}.md`))) missingReports.push(day)
    }
    checks.push({
      name: '每日日报',
      ok: missingReports.length === 0,
      detail:
        missingReports.length === 0 ? `最近 ${days} 天都有日报` : `缺少日报：${missingReports.join('、')}`,
    })
  }

  const last = store.lastRun()
  checks.push({
    name: '最近一轮不是 failed',
    ok: last !== undefined && last.health !== 'failed',
    detail: last ? `${localStamp(last.at)} ${last.health}（${last.trigger}）` : '没有任何 run 记录',
  })

  checks.push(rebuildCheck(store, options.evidencePath))

  return { checks, pass: checks.every((check) => check.ok) }
}

/** Copy the append-only log, rebuild a fresh view, and compare what the owner would see. */
function rebuildCheck(store: WatchStore, evidencePath: string): AcceptanceCheck {
  if (!existsSync(evidencePath)) return { name: '从日志重建一致', ok: false, detail: `找不到 ${evidencePath}` }
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-acceptance-'))
  const copy = join(dir, 'watch.jsonl')
  let rebuilt: WatchStore | undefined
  try {
    copyFileSync(evidencePath, copy)
    rebuilt = new WatchStore(copy, join(dir, 'watch.db'))
    const before = store
      .openFindings()
      .map((finding) => finding.id)
      .sort()
    const after = rebuilt
      .openFindings()
      .map((finding) => finding.id)
      .sort()
    const sameFindings = JSON.stringify(before) === JSON.stringify(after)
    const sameBaseline = store.latestBaseline()?.id === rebuilt.latestBaseline()?.id
    return {
      name: '从日志重建一致',
      ok: sameFindings && sameBaseline,
      detail: sameFindings && sameBaseline
        ? `未关闭发现 ${after.length} 条、基线一致`
        : `发现一致=${sameFindings}，基线一致=${sameBaseline}`,
    }
  } catch (error) {
    return { name: '从日志重建一致', ok: false, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    rebuilt?.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
