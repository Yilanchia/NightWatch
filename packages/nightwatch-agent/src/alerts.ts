import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Finding, Severity } from './types.js'

/**
 * Deterministic alert queue (implementation plan §3.6 F1).
 *
 * This is the part that must work with no model at all: a high finding produces an alert, deduped
 * per finding, with a recurrence kept as its own event. Delivery channels (webhook / device) are a
 * later, separate layer; the queue is the auditable state in between.
 */

export interface Alert {
  readonly type: 'alert'
  readonly id: string
  readonly at: number
  readonly findingId: string
  readonly key: string
  readonly severity: Severity
  readonly reason: 'new' | 'recurrence'
}

interface AlertAck {
  readonly type: 'alert-ack'
  readonly alertId: string
  readonly at: number
}

const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 }

export function severityAtLeast(severity: Severity, minimum: Severity): boolean {
  return RANK[severity] >= RANK[minimum]
}

/** Queue one alert per qualifying finding; already-alerted finding ids are not repeated. */
export function enqueueAlerts(
  path: string,
  findings: readonly Finding[],
  now: number,
  minimum: Severity = 'high',
): Alert[] {
  const existing = new Set(loadOpenAlerts(path).map((alert) => alert.findingId))
  const queued: Alert[] = []
  for (const finding of findings) {
    if (!severityAtLeast(finding.severity, minimum) || existing.has(finding.id)) continue
    const alert: Alert = {
      type: 'alert',
      id: `alert-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
      at: now,
      findingId: finding.id,
      key: finding.key,
      severity: finding.severity,
      reason: finding.recurrenceOf ? 'recurrence' : 'new',
    }
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(alert)}\n`, 'utf8')
    existing.add(finding.id)
    queued.push(alert)
  }
  return queued
}

/** Alerts that have not been acknowledged, in arrival order. */
export function loadOpenAlerts(path: string): Alert[] {
  if (!existsSync(path)) return []
  const alerts: Alert[] = []
  const acked = new Set<string>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as Alert | AlertAck
      if (event.type === 'alert') alerts.push(event)
      else if (event.type === 'alert-ack') acked.add(event.alertId)
    } catch {
      // Append-only; skip malformed lines.
    }
  }
  return alerts.filter((alert) => !acked.has(alert.id))
}

/** Acknowledge one open alert. Returns false when it is unknown or already acknowledged. */
export function acknowledgeAlert(path: string, alertId: string, now: number): boolean {
  if (!loadOpenAlerts(path).some((alert) => alert.id === alertId)) return false
  mkdirSync(dirname(path), { recursive: true })
  const ack: AlertAck = { type: 'alert-ack', alertId, at: now }
  appendFileSync(path, `${JSON.stringify(ack)}\n`, 'utf8')
  return true
}
