import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { correlate, emptyState, ingestBundle, registerNode } from './coordinator.js'
import { buildBundle } from './export.js'
import { ensureIdentity } from './identity.js'
import { WatchStore } from './store.js'
import type { WatchConfig } from './tools.js'
import type { Finding } from './types.js'

const at = 1_800_000_000_000

function nodeBundle(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `nightwatch-coord-${label}-`))
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
  const finding: Finding = {
    type: 'finding',
    id: `find-${label}`,
    at,
    kind: 'ssh_authorized_key_added',
    severity: 'medium',
    key: 'ssh:authorized_key:deadbeef',
    title: 'SSH 授权公钥新增',
    detail: '本地细节不应出境',
    epistemic: 'inferred',
    observationId: 'obs-1',
    status: 'candidate',
    firstSeen: at,
    lastSeen: at,
  }
  store.append(finding)
  const identity = ensureIdentity(dir)
  const bundle = buildBundle(store, config, identity, { now: at + 1000, days: 7 })
  return { dir, store, bundle, cleanup: () => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  } }
}

test('registered nodes are correlated and replays are idempotent', () => {
  const a = nodeBundle('a')
  const b = nodeBundle('b')
  try {
    const now = at + 2000
    let state = emptyState(now)
    const registeredA = registerNode(state, a.bundle, now)
    assert.equal(registeredA.ok, true)
    state = registeredA.state
    const registeredB = registerNode(state, b.bundle, now)
    assert.equal(registeredB.ok, true)
    state = registeredB.state
    assert.equal(registeredA.nodeId === registeredB.nodeId, false)

    const first = ingestBundle(state, a.bundle, now)
    assert.equal(first.ok, true)
    assert.equal(first.added, 1)
    state = first.state

    const second = ingestBundle(state, b.bundle, now)
    assert.equal(second.ok, true)
    assert.equal(second.added, 1)
    state = second.state

    const replay = ingestBundle(state, a.bundle, now + 1000)
    assert.equal(replay.ok, true)
    assert.equal(replay.added, 0)
    assert.equal(Object.keys(replay.state.findings).length, 2)

    const groups = correlate(replay.state)
    assert.equal(groups.length, 1)
    assert.equal(groups[0]!.key, 'ssh:authorized_key:deadbeef')
    assert.equal(groups[0]!.crossNode, true)
    assert.equal(groups[0]!.nodes.length, 2)
    assert.equal(JSON.stringify(replay.state).includes('本地细节不应出境'), false)
  } finally {
    a.cleanup()
    b.cleanup()
  }
})

test('an unregistered node, a tampered bundle or a changed key is refused', () => {
  const a = nodeBundle('a')
  try {
    const now = at + 2000
    const state = emptyState(now)

    const unregistered = ingestBundle(state, a.bundle, now)
    assert.equal(unregistered.ok, false)
    assert.match(unregistered.reason ?? '', /未登记/)

    const tampered = JSON.parse(JSON.stringify(a.bundle)) as typeof a.bundle
    ;(tampered.payload.findings[0] as { title: string }).title = '被改过'
    const rejected = registerNode(state, tampered, now)
    assert.equal(rejected.ok, false)
    assert.match(rejected.reason ?? '', /签名/)

    const known = {
      ...state,
      nodes: {
        [a.bundle.payload.node.id]: {
          publicKeyPem: '-----BEGIN PUBLIC KEY-----\nnot-the-same\n-----END PUBLIC KEY-----\n',
          firstSeen: now,
          lastSeen: now,
          registeredAt: now,
          lastSeq: 0,
          capabilities: a.bundle.payload.capabilities,
        },
      },
    }
    const conflict = registerNode(known, a.bundle, now)
    assert.equal(conflict.ok, false)
    assert.match(conflict.reason ?? '', /公钥/)
  } finally {
    a.cleanup()
  }
})
