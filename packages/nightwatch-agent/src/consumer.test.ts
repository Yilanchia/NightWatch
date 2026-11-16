import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { consumePending } from './consumer.js'
import { appendJudgment, validateJudgment } from './judgment.js'
import { enqueueInvestigations, loadPending } from './trigger.js'
import type { Finding } from './types.js'

const now = 1_800_000_000_000

function finding(id: string): Finding {
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
  }
}

test('a judgment marks the item done; a run without judgment leaves it pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-consumer-'))
  try {
    const pendingPath = join(dir, 'pending.jsonl')
    const judgmentsPath = join(dir, 'judgments.jsonl')
    const f1 = finding('f1')
    const f2 = finding('f2')
    enqueueInvestigations(pendingPath, [f1, f2], now)

    let clock = now
    const result = await consumePending({
      pendingPath,
      judgmentsPath,
      find: (id) => (id === 'f1' ? f1 : id === 'f2' ? f2 : undefined),
      now: () => clock++,
      run: async (target) => {
        if (target.id !== 'f1') return // f2 produces nothing
        const judgment = validateJudgment(
          {
            confirmed: [],
            candidates: [],
            counter: [],
            gaps: ['没有登录日志'],
            recommendation: '人工确认',
            disposition: 'escalate',
            confidence: 'low',
          },
          { finding: target, observationExists: () => false, now: clock, model: 'stub', budget: { calls: 0, ms: 0, bytes: 0 } },
        )
        assert.ok(judgment.judgment)
        appendJudgment(judgmentsPath, judgment.judgment)
      },
    })

    assert.equal(result.completed, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.remaining, 1)
    assert.deepEqual(
      loadPending(pendingPath).map((item) => item.findingId),
      ['f2'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
