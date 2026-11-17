import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startPanel } from './panel.js'
import { appendJudgment, validateJudgment } from './judgment.js'
import { WatchStore } from './store.js'
import { localDay } from './time.js'
import type { WatchConfig } from './tools.js'
import type { Finding } from './types.js'

test('the read-only panel serves summary, findings, timeline and reports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-panel-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  const reportDir = join(dir, 'watch-reports')
  mkdirSync(reportDir, { recursive: true })
  const now = Date.now()
  writeFileSync(join(reportDir, `${localDay(now)}.md`), '# 日报\n', 'utf8')
  const finding: Finding = {
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
  }
  store.append(finding)
  const judgmentsPath = join(dir, 'judgments.jsonl')
  const validated = validateJudgment(
    {
      confirmed: [],
      candidates: [{ text: '可能是数据库服务', likelihood: 'medium' }],
      counter: [],
      gaps: ['没有登录日志'],
      recommendation: '确认后更新基线',
      disposition: 'propose',
      confidence: 'medium',
    },
    { finding, observationExists: () => false, now, model: 'stub', budget: { calls: 1, ms: 5, bytes: 20 } },
  )
  assert.ok(validated.judgment)
  appendJudgment(judgmentsPath, validated.judgment)
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
  const panel = await startPanel({ store, config, port: 0, now: () => now, judgmentsPath })
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

    const investigations = (await (await fetch(`${panel.url}/api/investigations`)).json()) as {
      investigations: Array<{ latest: { candidates: unknown[]; gaps: string[] } }>
    }
    assert.equal(investigations.investigations.length, 1)
    assert.equal(investigations.investigations[0]?.latest.candidates.length, 1)
    assert.deepEqual(investigations.investigations[0]?.latest.gaps, ['没有登录日志'])

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

test('the panel surfaces the cross-node coordinator view when a state file is given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-panel-coord-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  const config: WatchConfig = {
    evidencePath: join(dir, 'watch.jsonl'), databasePath: join(dir, 'watch.db'), reportDir: join(dir, 'watch-reports'),
    ports: true, ssh: true, backup: false, backupPaths: [], backupStaleHours: 36,
  }
  const node = (collectors: string[]) => ({ publicKeyPem: 'x', firstSeen: 0, lastSeen: 1, registeredAt: 0, lastSeq: 1, capabilities: { platform: 'linux', collectors, backupPaths: false }, lastHealth: 'ok' })
  const finding = (nodeId: string) => ({ id: 'f1', key: 'ssh:permitrootlogin', kind: 'ssh_root_login', severity: 'high', status: 'candidate', title: 'SSH 允许 root 登录', nodeId, ingestedAt: 0 })
  const statePath = join(dir, 'coordinator-state.json')
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    nodes: { A: node(['ssh']), B: node(['ssh']) },
    findings: { 'A:f1': finding('A'), 'B:f1': finding('B') },
    updatedAt: 1,
  }), 'utf8')
  const panel = await startPanel({ store, config, coordinatorStatePath: statePath })
  try {
    const coord = (await (await fetch(`${panel.url}/api/coordinator`)).json()) as {
      present: boolean; nodes: unknown[]; crossNode: Array<{ key: string; nodes: string[] }>
    }
    assert.equal(coord.present, true)
    assert.equal(coord.nodes.length, 2)
    assert.equal(coord.crossNode.length, 1)
    assert.equal(coord.crossNode[0]?.key, 'ssh:permitrootlogin')
    assert.deepEqual(coord.crossNode[0]?.nodes, ['A', 'B'])
  } finally {
    await panel.close()
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('the coordinator view is absent (present:false) when no state file is configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-panel-nocoord-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  const config: WatchConfig = {
    evidencePath: join(dir, 'watch.jsonl'), databasePath: join(dir, 'watch.db'), reportDir: join(dir, 'watch-reports'),
    ports: true, ssh: true, backup: false, backupPaths: [], backupStaleHours: 36,
  }
  const panel = await startPanel({ store, config })
  try {
    const coord = (await (await fetch(`${panel.url}/api/coordinator`)).json()) as { present: boolean; nodes: unknown[] }
    assert.equal(coord.present, false)
    assert.equal(coord.nodes.length, 0)
  } finally {
    await panel.close()
    store.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
