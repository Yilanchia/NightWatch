import { statusLabel } from './health.js'
import { localStamp } from './time.js'
import type { WatchStore } from './store.js'
import type { TimelinePoint } from './types.js'

/**
 * Timeline queries: what happened to one fact (a port, an ssh option, a key fingerprint) over a
 * window. It answers "was it there before, when did it change, did the check even run" from the
 * evidence view, without guessing.
 */

export interface TimelineResult {
  readonly key: string
  readonly from: number
  readonly to: number
  readonly points: readonly TimelinePoint[]
}

export function queryTimeline(store: WatchStore, key: string, days: number, now: number): TimelineResult {
  const span = Math.max(1, Math.floor(days)) * 86_400_000
  const from = now - span
  return { key, from, to: now, points: store.timeline(key, from, now) }
}

const LABELS: Record<TimelinePoint['kind'], string> = {
  observed: '读到',
  finding: '发现',
  confirmed: '仍存在',
  resolved: '已恢复',
}

export function renderTimeline(result: TimelineResult): string {
  const lines: string[] = []
  lines.push(`时间线：${result.key}（${localStamp(result.from)} → ${localStamp(result.to)}）`)
  lines.push('')
  if (result.points.length === 0) {
    lines.push('这个窗口里没有读到这个 key，也没有相关发现。可能是采集没跑、失败，或者它从未出现过。')
    return lines.join('\n')
  }
  const observed = result.points.filter((point) => point.kind === 'observed')
  for (const point of result.points) {
    const status = point.kind === 'observed' && point.status && point.status !== 'ok' ? `（${statusLabel(point.status)}）` : ''
    lines.push(`- ${localStamp(point.at)} [${LABELS[point.kind]}] ${status}${point.detail}`)
  }
  lines.push('')
  if (observed.length === 0) {
    lines.push('窗口内没有成功的读取记录：这是证据缺口，不是“没有变化”。')
  } else {
    lines.push(`窗口内 ${observed.length} 次读取；缺的时段没有被补写，也不会被当成“没事”。`)
  }
  return lines.join('\n')
}

/** Owner-facing answer for the `watch_timeline` tool. */
export function timelineText(store: WatchStore, key: string, days: number, now: number): string {
  return renderTimeline(queryTimeline(store, key, days, now))
}
