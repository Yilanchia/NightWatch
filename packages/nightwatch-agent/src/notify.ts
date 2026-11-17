import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname } from 'node:path'
import { redactText } from './projection.js'
import type { Alert } from './alerts.js'
import type { Disposition, InvestigationJudgment } from './judgment.js'
import type { Finding, Severity } from './types.js'

/**
 * Outbound notification layer: the jump from "an alert sits in a queue" to "a person is told".
 *
 * Two halves, and the hard one is the discipline, not the sending:
 *  - discipline: a severity/disposition gate, per-finding rate limiting, quiet hours, and an
 *    escalation timer for urgent-and-unacknowledged. A system that cries wolf trains its owner to
 *    ignore it, so the default is to say less, not more.
 *  - projection: every message carries only a redacted summary (node / severity / title / key /
 *    the agent's disposition and one-line recommendation). Never evidence, keys or paths — it
 *    reuses the same redaction as the model-facing projection.
 *
 * The sink is a seam (console / file today; a real device channel is the self-built F2 layer). The
 * planning is pure and heavily tested; delivery is a thin wrapper that records what it sent so a
 * restart does not re-notify.
 */

export type NotificationLevel = 'silent' | 'notify' | 'urgent'

export interface NotifyPolicy {
  /** Minimum gap between deliveries for the same finding, in ms. */
  readonly minIntervalMs: number
  /** An urgent alert still unacknowledged after this long is re-delivered (escalation). */
  readonly escalateAfterMs: number
  /** Local hour [0,24) quiet window start; notify-level is deferred inside it, urgent is not. */
  readonly quietStartHour?: number
  readonly quietEndHour?: number
}

export const DEFAULT_POLICY: NotifyPolicy = {
  minIntervalMs: 60 * 60_000,
  escalateAfterMs: 60 * 60_000,
}

/**
 * Severity + the agent's disposition decide urgency. A high finding the agent could not explain
 * (no judgment yet) or explicitly escalated wakes someone; once there is a proposal or a benign
 * read it is a normal notification.
 */
export function decideLevel(severity: Severity, disposition?: Disposition): NotificationLevel {
  if (severity !== 'high') return 'silent'
  if (disposition === undefined || disposition === 'escalate') return 'urgent'
  return 'notify'
}

/** True when `now` falls in the local quiet window. Handles windows that wrap past midnight. */
export function withinQuietHours(now: number, policy: NotifyPolicy): boolean {
  if (policy.quietStartHour === undefined || policy.quietEndHour === undefined) return false
  const hour = new Date(now).getHours()
  const { quietStartHour: start, quietEndHour: end } = policy
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end
}

export interface NotificationMessage {
  readonly node: string
  readonly level: NotificationLevel
  readonly severity: Severity
  readonly key: string
  readonly title: string
  readonly reason: Alert['reason']
  readonly disposition?: Disposition
  readonly confidence?: string
  readonly recommendation?: string
  /** A short human line, already redacted. */
  readonly line: string
}

/**
 * Build the redacted, evidence-free summary a device receives. Free text (title, recommendation)
 * is passed through the projection redactor so a key or path cannot ride along.
 */
export function summarize(
  node: string,
  alert: Alert,
  level: NotificationLevel,
  finding?: Finding,
  judgment?: InvestigationJudgment,
): NotificationMessage {
  const title = redactText(finding?.title ?? alert.key)
  const recommendation = judgment ? redactText(judgment.recommendation) : undefined
  const reasonWord = alert.reason === 'recurrence' ? '复发' : '新发现'
  const dispWord = judgment
    ? { propose: '有修复方案待批', escalate: '需要你看一下', 'benign-pending-owner': '疑似正常，待你确认' }[judgment.disposition]
    : '尚未调查'
  const line = redactText(
    `[${node}] ${level === 'urgent' ? '紧急' : '通知'}·${reasonWord} ${title}（${alert.key}）— ${dispWord}` +
      (recommendation ? `：${recommendation}` : ''),
  )
  return {
    node,
    level,
    severity: alert.severity,
    key: alert.key,
    title,
    reason: alert.reason,
    ...(judgment ? { disposition: judgment.disposition } : {}),
    ...(judgment?.confidence ? { confidence: judgment.confidence } : {}),
    ...(recommendation ? { recommendation } : {}),
    line,
  }
}

// APPEND-MARKER

/** One persisted delivery, so a restart does not re-notify what was already sent. */
export interface SentRecord {
  readonly type: 'notification-sent'
  readonly alertId: string
  readonly findingId: string
  readonly at: number
  readonly level: NotificationLevel
}

export interface SentState {
  /** alertId -> { lastAt, count }. */
  readonly byAlert: Map<string, { lastAt: number; count: number }>
}

export function loadSent(path: string): SentState {
  const byAlert = new Map<string, { lastAt: number; count: number }>()
  if (!existsSync(path)) return { byAlert }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as SentRecord
      if (record.type !== 'notification-sent') continue
      const prior = byAlert.get(record.alertId)
      byAlert.set(record.alertId, { lastAt: record.at, count: (prior?.count ?? 0) + 1 })
    } catch {
      // Append-only history: a malformed line must not hide later records.
    }
  }
  return { byAlert }
}

export function recordSent(path: string, record: SentRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
}

export interface PlannedDelivery {
  readonly alert: Alert
  readonly message: NotificationMessage
  readonly reason: 'new' | 'escalation'
}

export interface Suppressed {
  readonly alertId: string
  readonly why: string
}

export interface DeliveryPlan {
  readonly deliveries: readonly PlannedDelivery[]
  readonly suppressed: readonly Suppressed[]
}

export interface PlanInput {
  readonly node: string
  readonly openAlerts: readonly Alert[]
  readonly sent: SentState
  readonly findings: ReadonlyMap<string, Finding>
  readonly judgments: ReadonlyMap<string, InvestigationJudgment>
  readonly now: number
  readonly policy: NotifyPolicy
}

/**
 * Decide what to send now. Pure: no files, no clock beyond `now`. Open alerts are already
 * unacknowledged (acknowledged ones never reach here), so an acknowledged risk is never re-notified.
 */
export function planDeliveries(input: PlanInput): DeliveryPlan {
  const deliveries: PlannedDelivery[] = []
  const suppressed: Suppressed[] = []
  const repeatThreshold = Math.max(input.policy.escalateAfterMs, input.policy.minIntervalMs)

  for (const alert of input.openAlerts) {
    const judgment = input.judgments.get(alert.findingId)
    const level = decideLevel(alert.severity, judgment?.disposition)
    if (level === 'silent') {
      suppressed.push({ alertId: alert.id, why: '低于通知阈值' })
      continue
    }
    const prior = input.sent.byAlert.get(alert.id)
    const message = summarize(input.node, alert, level, input.findings.get(alert.findingId), judgment)

    if (!prior) {
      if (level === 'notify' && withinQuietHours(input.now, input.policy)) {
        suppressed.push({ alertId: alert.id, why: '安静时段，通知级延后' })
        continue
      }
      deliveries.push({ alert, message, reason: 'new' })
      continue
    }
    // Already delivered and still open. Only an urgent risk re-fires, and only past the window.
    if (level === 'urgent' && input.now - prior.lastAt >= repeatThreshold) {
      deliveries.push({ alert, message, reason: 'escalation' })
    } else {
      suppressed.push({ alertId: alert.id, why: level === 'urgent' ? '未到升级窗口' : '已通知，等待确认' })
    }
  }
  return { deliveries, suppressed }
}

/** A delivery seam. Console and file sinks today; a real device channel is the F2 layer. */
export interface NotificationSink {
  readonly name: string
  send(message: NotificationMessage): Promise<void>
}

export const consoleSink: NotificationSink = {
  name: 'console',
  async send(message) {
    console.log(message.line)
  },
}

/** Append the projected message to a local file. No egress; safe default. */
export function fileSink(path: string): NotificationSink {
  return {
    name: `file:${path}`,
    async send(message) {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...message })}\n`, 'utf8')
    },
  }
}

/**
 * Device-channel push over built-in HTTPS (F2 stage 1). Zero new dependencies: node:https/http
 * only. The projected (already redacted) message is POSTed to a relay the owner controls; `format`
 * shapes the body for common phone-push bots. Self-built: it never links @fairy/link. The two-way
 * confirm (phone approves inline) is stage 2; here confirm still falls back to the CLI approval.
 */
export type PushFormat = 'json' | 'wecom' | 'feishu' | 'text'

/** Shape the redacted message for the target relay. */
export function shapePush(message: NotificationMessage, format: PushFormat): { body: string; contentType: string } {
  switch (format) {
    case 'wecom':
      return { body: JSON.stringify({ msgtype: 'text', text: { content: message.line } }), contentType: 'application/json' }
    case 'feishu':
      return { body: JSON.stringify({ msg_type: 'text', content: { text: message.line } }), contentType: 'application/json' }
    case 'text':
      return { body: message.line, contentType: 'text/plain; charset=utf-8' }
    default:
      return { body: JSON.stringify({ type: 'nightwatch-alert', at: Date.now(), ...message }), contentType: 'application/json' }
  }
}

export function httpsSink(url: string, format: PushFormat = 'json'): NotificationSink {
  const target = new URL(url)
  return {
    name: `push:${target.host}`,
    async send(message) {
      const { body, contentType } = shapePush(message, format)
      const requester = target.protocol === 'http:' ? httpRequest : httpsRequest
      await new Promise<void>((resolve, reject) => {
        const request = requester(
          target,
          { method: 'POST', headers: { 'content-type': contentType, 'content-length': Buffer.byteLength(body) } },
          (response) => {
            const code = response.statusCode ?? 0
            response.resume()
            if (code >= 200 && code < 300) resolve()
            else reject(new Error(`推送返回 HTTP ${code}`))
          },
        )
        request.on('error', reject)
        request.setTimeout(10_000, () => request.destroy(new Error('推送超时')))
        request.write(body)
        request.end()
      })
    },
  }
}

export interface NotifyResult {
  readonly delivered: number
  readonly escalated: number
  readonly suppressed: number
  readonly lines: readonly string[]
}

/**
 * Plan, deliver through the sink, and record each send. Delivery failures leave the alert
 * un-recorded so the next run retries it, rather than silently dropping it.
 */
export async function runNotify(
  input: PlanInput,
  sink: NotificationSink,
  sentPath: string,
): Promise<NotifyResult> {
  const plan = planDeliveries(input)
  const lines: string[] = []
  let delivered = 0
  let escalated = 0
  for (const item of plan.deliveries) {
    await sink.send(item.message)
    recordSent(sentPath, {
      type: 'notification-sent',
      alertId: item.alert.id,
      findingId: item.alert.findingId,
      at: input.now,
      level: item.message.level,
    })
    lines.push(`${item.reason === 'escalation' ? '↑升级' : '→发送'} ${item.message.line}`)
    delivered += 1
    if (item.reason === 'escalation') escalated += 1
  }
  return { delivered, escalated, suppressed: plan.suppressed.length, lines }
}
