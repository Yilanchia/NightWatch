import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { completeInvestigation, enqueueInvestigations, loadPending } from './trigger.js'
import type { Finding } from './types.js'

const now = 1_800_000_000_000

function finding(id: string, recurrenceOf?: string): Finding {
  return {
    type: 'finding',
    id,
    at: now,
    kind: 'new_listen_port',
    severity: 'high',
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

test('new findings are queued once and recurrences are labelled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-trigger-'))
  try {
    const path = join(dir, 'pending.jsonl')
    const first = enqueueInvestigations(path, [finding('f1'), finding('f2', 'f-old')], now)
    assert.equal(first.length, 2)
    assert.equal(first[1]?.reason, 'recurrence')

    // Same finding ids are not queued twice.
    assert.equal(enqueueInvestigations(path, [finding('f1')], now + 1).length, 0)
    assert.equal(loadPending(path).length, 2)

    completeInvestigation(path, 'f1', now + 2)
    assert.deepEqual(
      loadPending(path).map((item) => item.findingId),
      ['f2'],
    )

    // A recurrence is a new finding id, so it queues again.
    assert.equal(enqueueInvestigations(path, [finding('f3', 'f1')], now + 3).length, 1)
    assert.equal(loadPending(path).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
