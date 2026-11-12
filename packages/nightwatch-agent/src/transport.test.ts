import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { correlate, emptyState, registerNode } from './coordinator.js'
import { buildBundle } from './export.js'
import { ensureIdentity } from './identity.js'
import { WatchStore } from './store.js'
import { startCoordinatorServer } from './transport.js'
import type { WatchConfig } from './tools.js'
import type { Finding } from './types.js'

const at = 1_800_000_000_000

function makeNode(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `nightwatch-transport-${label}-`))
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
    kind: 'new_listen_port',
    severity: 'high',
    key: 'tcp:3306',
    title: '新开的监听端口',
    detail: '不应出境',
    epistemic: 'inferred',
    observationId: 'obs-1',
    status: 'candidate',
    firstSeen: at,
    lastSeen: at,
  }
  store.append(finding)
  const bundle = buildBundle(store, config, ensureIdentity(dir), { now: at + 1000, days: 7 })
  return {
    bundle,
    cleanup: () => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('the HTTP prototype accepts registered signed bundles and refuses strangers', async () => {
  const a = makeNode('a')
  const b = makeNode('b')
  const c = makeNode('c')
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-transport-state-'))
  const statePath = join(dir, 'state.json')
  let server: Awaited<ReturnType<typeof startCoordinatorServer>> | undefined
  try {
    const now = at + 2000
    let state = emptyState(now)
    const regA = registerNode(state, a.bundle, now)
    const regB = registerNode(regA.state, b.bundle, now)
    writeFileSync(statePath, `${JSON.stringify(regB.state, null, 2)}\n`, 'utf8')

    const running = await startCoordinatorServer({ statePath })
    server = running

    const status = (await (await fetch(`${running.url}/v1/status`)).json()) as { nodes: string[]; findings: number }
    assert.equal(status.nodes.length, 2)
    assert.equal(status.findings, 0)

    const push = async (bundle: unknown) => {
      const response = await fetch(`${running.url}/v1/bundle`, { method: 'POST', body: JSON.stringify(bundle) })
      return { status: response.status, body: (await response.json()) as { ok: boolean; added?: number; reason?: string } }
    }

    const first = await push(a.bundle)
    assert.equal(first.status, 200)
    assert.equal(first.body.ok, true)
    assert.equal(first.body.added, 1)

    const replay = await push(a.bundle)
    assert.equal(replay.status, 200)
    assert.equal(replay.body.added, 0)

    const second = await push(b.bundle)
    assert.equal(second.status, 200)
    assert.equal(second.body.added, 1)

    const stranger = await push(c.bundle)
    assert.equal(stranger.status, 403)
    assert.match(stranger.body.reason ?? '', /未登记/)

    const persisted = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(Object.keys(persisted.findings).length, 2)
    const groups = correlate(persisted)
    assert.equal(groups[0]!.crossNode, true)
  } finally {
    if (server) await server.close()
    a.cleanup()
    b.cleanup()
    c.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
