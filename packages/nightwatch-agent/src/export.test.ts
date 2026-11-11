import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBundle, verifyBundle } from './export.js'
import { ensureIdentity, nodeIdFor, signPayload, verifyPayload } from './identity.js'
import { WatchStore } from './store.js'
import type { WatchConfig } from './tools.js'
import type { Finding, Observation } from './types.js'

const at = 1_800_000_000_000

test('a node identity is stable and its signatures verify', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-identity-'))
  try {
    const first = ensureIdentity(dir)
    const second = ensureIdentity(dir)
    assert.equal(first.id, second.id)
    assert.match(first.id, /^nw-[A-Za-z0-9_-]{12}$/)
    assert.equal(nodeIdFor(first.publicKeyPem), first.id)

    const payload = 'hello bundle'
    const signature = signPayload(first, payload)
    assert.equal(verifyPayload(first.publicKeyPem, payload, signature), true)
    assert.equal(verifyPayload(first.publicKeyPem, `${payload}!`, signature), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the exported bundle carries findings and health but no raw facts or evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-bundle-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  const config: WatchConfig = {
    evidencePath: join(dir, 'watch.jsonl'),
    databasePath: join(dir, 'watch.db'),
    reportDir: join(dir, 'reports'),
    ports: true,
    ssh: false,
    backup: false,
    backupPaths: [],
    backupStaleHours: 36,
  }
  try {
    const observation: Observation = {
      type: 'observation',
      id: 'obs-1',
      at,
      host: 'host',
      collector: 'ports',
      facts: [{ kind: 'listen_port', key: 'tcp:3306', value: '0.0.0.0:3306' }],
      evidence: [{ command: 'ss -ltnp', exit: 0, outputSha256: 'secret-hash' }],
      status: 'ok',
    }
    const finding: Finding = {
      type: 'finding',
      id: 'find-1',
      at,
      kind: 'new_listen_port',
      severity: 'high',
      key: 'tcp:3306',
      title: '新开的监听端口',
      detail: '0.0.0.0:3306（这条 detail 不应出境）',
      epistemic: 'inferred',
      observationId: 'obs-1',
      status: 'candidate',
      firstSeen: at,
      lastSeen: at,
    }
    const run = { type: 'run' as const, id: 'run-1', at, trigger: 'tick', health: 'ok' as const, blindSpots: [], notes: [] }
    store.append(observation)
    store.append(finding)
    store.append(run)

    const identity = ensureIdentity(dir)
    const bundle = buildBundle(store, config, identity, { now: at + 1000, days: 7 })
    const text = JSON.stringify(bundle)
    assert.equal(text.includes('facts'), false)
    assert.equal(text.includes('evidence'), false)
    assert.equal(text.includes('secret-hash'), false)
    assert.equal(text.includes('这条 detail 不应出境'), false)
    assert.equal(text.includes('observationId'), false)

    assert.equal(bundle.payload.findings.length, 1)
    assert.equal(bundle.payload.findings[0]!.key, 'tcp:3306')
    assert.equal(bundle.payload.runs.length, 1)
    assert.deepEqual(verifyBundle(bundle), { ok: true })

    const tampered = JSON.parse(text) as typeof bundle
    ;(tampered.payload.findings[0] as { title: string }).title = '被改过的标题'
    const verdict = verifyBundle(tampered)
    assert.equal(verdict.ok, false)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
