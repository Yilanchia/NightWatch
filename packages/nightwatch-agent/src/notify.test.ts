import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_POLICY,
  decideLevel,
  fileSink,
  loadSent,
  planDeliveries,
  runNotify,
  summarize,
  withinQuietHours,
  type NotifyPolicy,
} from './notify.js'
import type { Alert } from './alerts.js'
import type { InvestigationJudgment } from './judgment.js'
import type { Finding } from './types.js'

const now = 1_800_000_000_000

function alert(id: string, findingId: string, reason: Alert['reason'] = 'new'): Alert {
  return { type: 'alert', id, at: now, findingId, key: 'ssh:permitrootlogin', severity: 'high', reason }
}

function finding(id: string): Finding {
  return {
    type: 'finding', id, at: now, kind: 'ssh_root_login', severity: 'high',
    key: 'ssh:permitrootlogin', title: 'SSH 允许 root 登录', detail: 'x', epistemic: 'observed',
    observationId: 'obs-1', status: 'candidate', firstSeen: now, lastSeen: now,
  }
}

function judgment(findingId: string, disposition: InvestigationJudgment['disposition'], recommendation = '建议改密钥登录'): InvestigationJudgment {
  return {
    type: 'investigation-judgment', id: `judg-${findingId}`, at: now, findingId, key: 'ssh:permitrootlogin',
    source: 'model', model: 'test', confirmed: [], candidates: [], counter: [], gaps: [],
    recommendation, disposition, confidence: 'medium',
  }
}

test('level: unexplained or escalated high is urgent; a proposal/benign read is a normal notify', () => {
  assert.equal(decideLevel('high', undefined), 'urgent')
  assert.equal(decideLevel('high', 'escalate'), 'urgent')
  assert.equal(decideLevel('high', 'propose'), 'notify')
  assert.equal(decideLevel('high', 'benign-pending-owner'), 'notify')
  assert.equal(decideLevel('medium', undefined), 'silent')
  assert.equal(decideLevel('low', 'escalate'), 'silent')
})

test('quiet hours handle a window that wraps past midnight; urgent will ignore it (see plan)', () => {
  const policy: NotifyPolicy = { ...DEFAULT_POLICY, quietStartHour: 23, quietEndHour: 7 }
  const at = (h: number) => new Date(2026, 10, 17, h, 0, 0).getTime()
  assert.equal(withinQuietHours(at(2), policy), true)
  assert.equal(withinQuietHours(at(23), policy), true)
  assert.equal(withinQuietHours(at(12), policy), false)
  assert.equal(withinQuietHours(at(2), DEFAULT_POLICY), false) // no window configured
})

test('summary is redacted and carries no evidence, only a disposition line', () => {
  const f = finding('f1')
  const j = judgment('f1', 'propose', '改 /home/alice/.ssh/authorized_keys 后重启 sshd')
  const message = summarize('node-x', alert('a1', 'f1'), 'notify', f, j)
  assert.equal(message.line.includes('/home/alice'), false) // path redacted
  assert.match(message.line, /\[REDACTED:path\]/)
  assert.equal(message.disposition, 'propose')
  assert.match(message.line, /node-x/)
})

test('a new unexplained high alert is delivered as urgent', () => {
  const plan = planDeliveries({
    node: 'n', openAlerts: [alert('a1', 'f1')], sent: loadSent('/does/not/exist'),
    findings: new Map([['f1', finding('f1')]]), judgments: new Map(), now, policy: DEFAULT_POLICY,
  })
  assert.equal(plan.deliveries.length, 1)
  assert.equal(plan.deliveries[0]!.message.level, 'urgent')
  assert.equal(plan.deliveries[0]!.reason, 'new')
})

test('a notify-level alert is deferred inside quiet hours, but urgent is not', () => {
  const quiet: NotifyPolicy = { ...DEFAULT_POLICY, quietStartHour: 0, quietEndHour: 24 } // always quiet
  const base = {
    node: 'n', sent: loadSent('/none'), findings: new Map([['f1', finding('f1')]]), now, policy: quiet,
  }
  const asNotify = planDeliveries({ ...base, openAlerts: [alert('a1', 'f1')], judgments: new Map([['f1', judgment('f1', 'propose')]]) })
  assert.equal(asNotify.deliveries.length, 0)
  assert.equal(asNotify.suppressed[0]!.why.includes('安静时段'), true)

  const asUrgent = planDeliveries({ ...base, openAlerts: [alert('a1', 'f1')], judgments: new Map([['f1', judgment('f1', 'escalate')]]) })
  assert.equal(asUrgent.deliveries.length, 1)
})

test('an already-delivered urgent re-fires only past the escalation window', () => {
  const sent = { byAlert: new Map([['a1', { lastAt: now - 10 * 60_000, count: 1 }]]) }
  const base = {
    node: 'n', openAlerts: [alert('a1', 'f1')], findings: new Map([['f1', finding('f1')]]),
    judgments: new Map(), // unexplained => urgent
  }
  const tooSoon = planDeliveries({ ...base, sent, now, policy: { ...DEFAULT_POLICY, escalateAfterMs: 60 * 60_000 } })
  assert.equal(tooSoon.deliveries.length, 0)
  assert.equal(tooSoon.suppressed[0]!.why.includes('升级'), true)

  const late = planDeliveries({ ...base, sent, now, policy: { ...DEFAULT_POLICY, escalateAfterMs: 5 * 60_000, minIntervalMs: 5 * 60_000 } })
  assert.equal(late.deliveries.length, 1)
  assert.equal(late.deliveries[0]!.reason, 'escalation')
})

test('runNotify delivers through the sink and records sends so a rerun does not repeat them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-notify-'))
  try {
    const sentPath = join(dir, 'notifications.jsonl')
    const outPath = join(dir, 'out.jsonl')
    const input = {
      node: 'n', openAlerts: [alert('a1', 'f1')], findings: new Map([['f1', finding('f1')]]),
      judgments: new Map(), now, policy: DEFAULT_POLICY,
    }
    const first = await runNotify({ ...input, sent: loadSent(sentPath) }, fileSink(outPath), sentPath)
    assert.equal(first.delivered, 1)
    assert.equal(readFileSync(outPath, 'utf8').trim().split('\n').length, 1)

    // Rerun with the recorded state: nothing new to send.
    const second = await runNotify({ ...input, sent: loadSent(sentPath) }, fileSink(outPath), sentPath)
    assert.equal(second.delivered, 0)
    assert.equal(second.suppressed, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
