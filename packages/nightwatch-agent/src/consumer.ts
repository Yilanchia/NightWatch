import type { Finding } from './types.js'
import { loadJudgments } from './judgment.js'
import { completeInvestigation, loadPending } from './trigger.js'

/**
 * Consume the pending-investigation queue.
 *
 * The daemon only enqueues; this loop is the piece that needs a model. It is deliberately separate
 * so that:
 *   - no model means nothing is consumed (the queue is the honest "not investigated" record);
 *   - a failed/unavailable model leaves the item pending, never fabricates a judgment;
 *   - a completed item is only marked done when a judgment for that finding actually landed.
 */

export interface ConsumeOptions {
  readonly pendingPath: string
  readonly judgmentsPath: string
  readonly find: (findingId: string) => Finding | undefined
  readonly run: (finding: Finding) => Promise<void>
  readonly now: () => number
  readonly limit?: number
}

export interface ConsumeResult {
  readonly attempted: number
  readonly completed: number
  readonly failed: number
  readonly remaining: number
  readonly details: ReadonlyArray<{ findingId: string; ok: boolean; reason?: string }>
}

export async function consumePending(options: ConsumeOptions): Promise<ConsumeResult> {
  const pending = loadPending(options.pendingPath)
  const limit = Math.max(0, options.limit ?? pending.length)
  const details: Array<{ findingId: string; ok: boolean; reason?: string }> = []
  let completed = 0
  let failed = 0
  let attempted = 0

  for (const item of pending.slice(0, limit)) {
    const finding = options.find(item.findingId)
    if (!finding) {
      failed += 1
      details.push({ findingId: item.findingId, ok: false, reason: '发现已不存在' })
      continue
    }
    attempted += 1
    const startedAt = options.now()
    try {
      await options.run(finding)
      const landed = loadJudgments(options.judgmentsPath).some(
        (judgment) => judgment.findingId === finding.id && judgment.at >= startedAt,
      )
      if (landed) {
        completeInvestigation(options.pendingPath, finding.id, options.now())
        completed += 1
        details.push({ findingId: finding.id, ok: true })
      } else {
        failed += 1
        details.push({ findingId: finding.id, ok: false, reason: '没有产生判断，保留 pending' })
      }
    } catch (error) {
      failed += 1
      details.push({
        findingId: finding.id,
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    attempted,
    completed,
    failed,
    remaining: loadPending(options.pendingPath).length,
    details,
  }
}
