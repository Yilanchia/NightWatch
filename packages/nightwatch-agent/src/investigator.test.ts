import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendNote, InvestigationBudget } from './investigator.js'

test('tool-call budget denies further evidence calls once exhausted', () => {
  const budget = new InvestigationBudget({ calls: 2, ms: 60_000, bytes: 1000 })
  assert.equal(budget.check().allow, true)
  budget.chargeCall()
  assert.equal(budget.check().allow, true)
  budget.chargeCall()
  const denied = budget.check()
  assert.equal(denied.allow, false)
  assert.match(denied.reason ?? '', /调用达到 2 次/)
  // The stop reason is sticky.
  assert.equal(budget.check().allow, false)
})

test('byte and wall-clock budgets also stop the investigation', () => {
  let now = 0
  const bytes = new InvestigationBudget({ calls: 10, ms: 60_000, bytes: 10 }, () => now)
  bytes.chargeBytes(10)
  assert.equal(bytes.check().allow, false)

  now = 0
  const clock = new InvestigationBudget({ calls: 10, ms: 1000, bytes: 1000 }, () => now)
  now = 1001
  const denied = clock.check()
  assert.equal(denied.allow, false)
  assert.match(denied.reason ?? '', /墙钟/)
})

test('annotations are inferred, sourced, and kept outside the evidence log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-investigator-'))
  try {
    const notePath = join(dir, 'investigations.jsonl')
    const note = appendNote(notePath, { key: 'tcp:3306', text: '这可能是数据库端口', confidence: 'low' })
    assert.equal(note.source, 'model')
    assert.equal(note.epistemic, 'inferred')
    assert.equal(note.key, 'tcp:3306')
    const lines = readFileSync(notePath, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(JSON.parse(lines[0]!).epistemic, 'inferred')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
