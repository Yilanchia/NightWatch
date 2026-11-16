import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startPanel } from './panel.js'
import { WatchStore } from './store.js'
import { localDay } from './time.js'
import type { WatchConfig } from './tools.js'

test('the read-only panel serves summary, findings, timeline and reports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-panel-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  const reportDir = join(dir, 'watch-reports')
  mkdirSync(reportDir, { recursive: true })
  const now = Date.now()
  writeFileSync(join(reportDir, `${localDay(now)}.md`), '# 日报\n', 'utf8')
  store.append({
    type: 'finding',
    id: 'find-panel',
    at: now,
    kind: 'new_listen_port',
    severity: 'high',
    key: 'tcp:3306',
    title: '新开的监听端口',
    detail: '3306',
    epistemic: 'inferred',
    observationId: 'obs-1',
    status: 'candidate',
    firstSeen: now,
    lastSeen: now,
  })
  store.append({
    type: 'run',
    id: 'run-panel',
    at: now,
    trigger: 'tick',
    health: 'ok',
    blindSpots: [],
    notes: [],
    reportPath: join(reportDir, `${localDay(now)}.md`),
  })
  const config: WatchConfig = {
    evidencePath: join(dir, 'watch.jsonl'),
    databasePath: join(dir, 'watch.db'),
    reportDir,
    ports: true,
    ssh: false,
    backup: false,
    backupPaths: [],
    backupStaleHours: 36,
  }
  const panel = await startPanel({ store, config, port: 0, now: () => now })
  try {
    const summary = (await (await fetch(`${panel.url}/api/summary`)).json()) as {
      open: number
      reports: unknown[]
      blindSpots: string[]
    }
    assert.equal(summary.open, 1)
    assert.equal(summary.reports.length, 1)

    const findings = (await (await fetch(`${panel.url}/api/findings`)).json()) as { findings: unknown[] }
    assert.equal(findings.findings.length, 1)

    const timeline = (await (await fetch(`${panel.url}/api/timeline?key=tcp:3306&days=1`)).json()) as { text: string }
    assert.equal(typeof timeline.text, 'string')

    assert.equal((await fetch(`${panel.url}/api/timeline`)).status, 400)
    assert.equal((await fetch(`${panel.url}/api/nope`)).status, 404)
    assert.equal((await fetch(`${panel.url}/api/summary`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${panel.url}/`)).status, 200)
  } finally {
    await panel.close()
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
