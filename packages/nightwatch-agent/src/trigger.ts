import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Finding } from './types.js'

/**
 * Pending investigation queue.
 *
 * The daemon is deterministic and must never wait for a model. When a run produces a new finding
 * (or a recurrence), it enqueues a pending investigation. A model-backed consumer can later claim
 * and complete it; when no model is configured the queue is simply the honest "not investigated
 * yet" record. Append-only, deduplicated by finding id, and separate from the evidence log.
 */

export interface PendingInvestigation {
  readonly type: 'pending-investigation'
  readonly id: string
  readonly at: number
  readonly findingId: string
  readonly key: string
  readonly reason: 'new' | 'recurrence'
}

interface DoneEvent {
  readonly type: 'investigation-done'
  readonly findingId: string
  readonly at: number
}

export function loadPending(path: string): PendingInvestigation[] {
  if (!existsSync(path)) return []
  const pending = new Map<string, PendingInvestigation>()
  const done = new Set<string>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as PendingInvestigation | DoneEvent
      if (event.type === 'pending-investigation') pending.set(event.findingId, event)
      else if (event.type === 'investigation-done') done.add(event.findingId)
    } catch {
      // Append-only: skip malformed lines.
    }
  }
  return [...pending.values()].filter((item) => !done.has(item.findingId))
}

/** Queue one pending investigation per finding that is not already pending for that id. */
export function enqueueInvestigations(path: string, findings: readonly Finding[], now: number): PendingInvestigation[] {
  const existing = new Set(loadPending(path).map((item) => item.findingId))
  const queued: PendingInvestigation[] = []
  for (const finding of findings) {
    if (existing.has(finding.id)) continue
    const item: PendingInvestigation = {
      type: 'pending-investigation',
      id: `invq-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
      at: now,
      findingId: finding.id,
      key: finding.key,
      reason: finding.recurrenceOf ? 'recurrence' : 'new',
    }
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(item)}\n`, 'utf8')
    existing.add(finding.id)
    queued.push(item)
  }
  return queued
}

/** Mark one investigation as completed so it no longer appears as pending. */
export function completeInvestigation(path: string, findingId: string, now: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const event: DoneEvent = { type: 'investigation-done', findingId, at: now }
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8')
}
