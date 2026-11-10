import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchStore } from './store.js'
import type { Finding, Observation } from './types.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-store-'))
  return { dir, jsonl: join(dir, 'watch.jsonl'), db: join(dir, 'watch.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const at = 1_800_000_000_000

function observation(): Observation {
  return {
    type: 'observation',
    id: 'obs-1',
    at,
    host: 'host',
    collector: 'ports',
    facts: [{ kind: 'listen_port', key: 'tcp:22', value: '0.0.0.0:22' }],
    evidence: [{ command: 'ss -ltnp', exit: 0, outputSha256: 'abc' }],
  }
}

function finding(): Finding {
  return {
    type: 'finding',
    id: 'find-1',
    at,
    kind: 'new_listen_port',
    severity: 'high',
    key: 'tcp:3306',
    title: '新开的监听端口',
    detail: 'x',
    epistemic: 'inferred',
    observationId: 'obs-1',
    status: 'candidate',
  }
}

test('the view answers from the log', () => {
  const { jsonl, db, cleanup } = fixture()
  const store = new WatchStore(jsonl, db)
  store.append(observation())
  store.append(finding())
  store.append({ type: 'baseline', id: 'base-1', at, host: 'host', facts: observation().facts, observationIds: ['obs-1'] })

  assert.equal(store.latestBaseline()?.id, 'base-1')
  assert.equal(store.latestObservations().get('ports')?.id, 'obs-1')
  assert.deepEqual(store.openFindingKeys(), new Set(['tcp:3306']))
  assert.equal(store.findings('key = ?', 'tcp:3306').length, 1)
  store.close()
  cleanup()
})

test('deleting the view rebuilds it from the log alone', () => {
  const { jsonl, db, cleanup } = fixture()
  const first = new WatchStore(jsonl, db)
  first.append(observation())
  first.close()

  rmSync(db, { force: true })
  const second = new WatchStore(jsonl, db)
  assert.equal(second.latestObservations().get('ports')?.facts.length, 1)
  second.close()
  cleanup()
})

test('lastOkAt only counts successful reads', () => {
  const { jsonl, db, cleanup } = fixture()
  const store = new WatchStore(jsonl, db)
  store.append(observation())
  store.append({
    ...observation(),
    id: 'obs-2',
    at: at + 1000,
    evidence: [{ command: 'ss -ltnp', exit: 1, outputSha256: 'x', reason: '退出码 1' }],
    status: 'failed',
  })
  store.append({ ...observation(), id: 'obs-3', collector: 'ssh' })
  assert.equal(store.lastOkAt('ports'), at)
  assert.equal(store.lastOkAt('ssh'), at)
  store.close()
  cleanup()
})

test('a torn last line is moved aside and the next event survives a reopen', () => {
  const { jsonl, db, cleanup } = fixture()
  const store = new WatchStore(jsonl, db)
  store.append(observation())
  store.close()
  // Simulate a crash mid-write: a line that never finished.
  appendFileSync(jsonl, '{"type":"observation","id":', 'utf8')

  const reopened = new WatchStore(jsonl, db)
  assert.equal(reopened.latestObservations().size, 1)
  assert.ok(reopened.recovery)
  assert.ok(existsSync(reopened.recovery.tornPath))
  reopened.append({ ...observation(), id: 'obs-2' })
  reopened.close()

  const third = new WatchStore(jsonl, db)
  assert.equal(third.events().filter((event) => event.type === 'observation').length, 2)
  assert.equal(third.recovery, undefined)
  third.close()
  cleanup()
})

test('corruption in the middle of the log is an error, not a skipped line', () => {
  const { jsonl, db, cleanup } = fixture()
  const store = new WatchStore(jsonl, db)
  store.append(observation())
  store.close()
  appendFileSync(jsonl, 'this is not json\n', 'utf8')
  appendFileSync(jsonl, `${JSON.stringify({ ...observation(), id: 'obs-2' })}\n`, 'utf8')

  assert.throws(() => new WatchStore(jsonl, db), /第 2 行损坏/)
  cleanup()
})

test('a second writer is refused while the first is open', () => {
  const { jsonl, db, cleanup } = fixture()
  const first = new WatchStore(jsonl, db)
  try {
    assert.throws(() => new WatchStore(jsonl, db), /正在写/)
  } finally {
    first.close()
  }
  const after = new WatchStore(jsonl, db)
  after.close()
  cleanup()
})

test('a duplicate event id is refused instead of silently overwritten', () => {
  const { jsonl, db, cleanup } = fixture()
  const store = new WatchStore(jsonl, db)
  store.append(observation())
  store.close()
  appendFileSync(jsonl, `${JSON.stringify(observation())}\n`, 'utf8')

  assert.throws(() => new WatchStore(jsonl, db), /重复的事件 ID/)
  cleanup()
})

test('a read-only store reads while the writer holds the lock', () => {
  const { jsonl, db, cleanup } = fixture()
  const writer = new WatchStore(jsonl, db)
  writer.append(observation())
  const reader = new WatchStore(jsonl, db, { readOnly: true })
  try {
    assert.equal(reader.latestObservations().get('ports')?.id, 'obs-1')
    assert.throws(() => reader.append(observation()), /read-only/)
    assert.throws(() => reader.rebuild(), /read-only/)
  } finally {
    reader.close()
    writer.close()
    cleanup()
  }
})
