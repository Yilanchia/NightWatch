import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acknowledgeAlert, enqueueAlerts, loadOpenAlerts } from './alerts.js'
import type { Finding } from './types.js'

const now = 1_800_000_000_000

function finding(id: string, severity: 'low' | 'medium' | 'high', recurrenceOf?: string): Finding {
  return {
    type: 'finding',
    id,
    at: now,
    kind: 'new_listen_port',
    severity,
    key: 'tcp:4444',
    title: '新开的监听端口',
    detail: '4444',
    epistemic: 'inferred',
    observationId: 'obs-1',
    status: 'candidate',
    firstSeen: now,
    lastSeen: now,
    ...(recurrenceOf ? { recurrenceOf } : {}),
  }
}

test('high findings alert once; recurrence alerts again; low/medium stay out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-alerts-'))
  try {
    const path = join(dir, 'alerts.jsonl')
    const queued = enqueueAlerts(
      path,
      [finding('f1', 'high'), finding('f2', 'medium'), finding('f3', 'low'), finding('f4', 'high', 'f1')],
      now,
    )
    assert.equal(queued.length, 2)
    assert.equal(queued[1]?.reason, 'recurrence')
    assert.equal(enqueueAlerts(path, [finding('f1', 'high')], now + 1).length, 0)

    const open = loadOpenAlerts(path)
    assert.equal(open.length, 2)
    assert.equal(acknowledgeAlert(path, open[0]!.id, now + 2), true)
    assert.equal(acknowledgeAlert(path, open[0]!.id, now + 3), false)
    assert.equal(loadOpenAlerts(path).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
