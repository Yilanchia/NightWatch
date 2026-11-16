import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendJudgment, loadJudgments, validateJudgment, type JudgmentInput } from './judgment.js'
import type { Finding } from './types.js'

const now = 1_800_000_000_000
const finding: Finding = {
  type: 'finding',
  id: 'find-1',
  at: now,
  kind: 'ssh_password_authentication',
  severity: 'high',
  key: 'ssh:passwordauthentication',
  title: 'SSH 允许密码登录',
  detail: '密码登录开着',
  epistemic: 'observed',
  observationId: 'obs-1',
  status: 'candidate',
  firstSeen: now,
  lastSeen: now,
}

function valid(overrides: Partial<JudgmentInput> = {}): JudgmentInput {
  return {
    confirmed: [{ text: 'sshd -T 显示 PasswordAuthentication yes', evidenceRef: 'obs-1' }],
    candidates: [{ text: '可能是运维临时方便', likelihood: 'medium' }],
    counter: ['没有新增公钥'],
    gaps: ['读不到登录日志'],
    recommendation: '确认合法后改密钥登录并更新基线',
    disposition: 'propose',
    confidence: 'medium',
    ...overrides,
  }
}

const context = {
  finding,
  observationExists: (id: string) => id === 'obs-1',
  now,
  model: 'stub-local',
  budget: { calls: 2, ms: 1000, bytes: 500 },
}

test('a compliant judgment is accepted and carries its binding', () => {
  const result = validateJudgment(valid(), context)
  assert.equal(result.ok, true)
  assert.equal(result.judgment?.findingId, 'find-1')
  assert.equal(result.judgment?.source, 'model')
  assert.equal(result.judgment?.confirmed[0]?.evidenceRef, 'obs-1')
})

test('confirmed must point at a real observation; inferred does not pretend to be fact', () => {
  const missing = validateJudgment(
    valid({ confirmed: [{ text: '看起来像攻击', evidenceRef: 'obs-does-not-exist' }] }),
    context,
  )
  assert.equal(missing.ok, false)
  assert.match(missing.errors.join('；'), /不存在的观测/)

  const badDisposition = validateJudgment(valid({ disposition: 'auto-fix' as never }), context)
  assert.equal(badDisposition.ok, false)
})

test('judgments append and reload without touching the evidence log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-judgment-'))
  try {
    const path = join(dir, 'judgments.jsonl')
    const result = validateJudgment(valid(), context)
    assert.ok(result.judgment)
    appendJudgment(path, result.judgment)
    const loaded = loadJudgments(path)
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]?.id, result.judgment.id)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
