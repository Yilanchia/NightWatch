import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAcceptance } from './acceptance.js'
import { WatchStore } from './store.js'
import { localDay } from './time.js'

const DAY = 86_400_000

function runEvent(id: string, at: number, reportPath: string) {
  return {
    type: 'run' as const,
    id,
    at,
    trigger: 'scheduler',
    health: 'ok' as const,
    blindSpots: [],
    notes: [],
    reportPath,
  }
}

test('acceptance passes when runs, reports, health and rebuild all agree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-acceptance-test-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  const now = Date.now()
  const reportDir = join(dir, 'watch-reports')
  mkdirSync(reportDir, { recursive: true })
  for (const offset of [1, 0]) {
    const day = localDay(now - offset * DAY)
    writeFileSync(join(reportDir, `${day}.md`), '# 日报\n', 'utf8')
  }
  store.append(runEvent('run-1', now - DAY, join(reportDir, `${localDay(now - DAY)}.md`)))
  store.append(runEvent('run-2', now, join(reportDir, `${localDay(now)}.md`)))
  try {
    const result = runAcceptance(store, { now, days: 2, evidencePath: join(dir, 'watch.jsonl'), reportDir })
    assert.equal(result.pass, true, JSON.stringify(result.checks))
    assert.equal(result.checks.length, 4)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('acceptance fails on a missing day or missing report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-acceptance-fail-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  const now = Date.now()
  const reportDir = join(dir, 'watch-reports')
  mkdirSync(reportDir, { recursive: true })
  // Only today has a run; yesterday is missing.
  store.append(runEvent('run-1', now, join(reportDir, `${localDay(now)}.md`)))
  try {
    const result = runAcceptance(store, { now, days: 2, evidencePath: join(dir, 'watch.jsonl'), reportDir })
    assert.equal(result.pass, false)
    const daily = result.checks.find((check) => check.name === '每日 run 记录')
    assert.equal(daily?.ok, false)
    const reports = result.checks.find((check) => check.name === '每日日报')
    assert.equal(reports?.ok, false)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
