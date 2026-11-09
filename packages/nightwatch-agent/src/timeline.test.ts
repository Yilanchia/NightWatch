import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchStore } from './store.js'
import { queryTimeline, renderTimeline } from './timeline.js'
import type { Finding, Observation } from './types.js'

const at = 1_800_000_000_000
const hour = 3_600_000

function observation(id: string, when: number, exit: number): Observation {
  return {
    type: 'observation',
    id,
    at: when,
    host: 'host',
    collector: 'ports',
    facts: [{ kind: 'listen_port', key: 'tcp:3306', value: '0.0.0.0:3306' }],
    evidence: [
      { command: 'ss -ltnp', exit, outputSha256: 'x', ...(exit === 0 ? {} : { reason: '退出码 127' }) },
    ],
    status: exit === 0 ? 'ok' : 'failed',
  }
}

function finding(id: string, when: number): Finding {
  return {
    type: 'finding',
    id,
    at: when,
    kind: 'new_listen_port',
    severity: 'high',
    key: 'tcp:3306',
    title: '新开的监听端口',
    detail: '3306',
    epistemic: 'inferred',
    observationId: 'obs-1',
    status: 'candidate',
    firstSeen: when,
    lastSeen: when,
  }
}

test('the timeline shows reads, the finding, confirmation and resolution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-timeline-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  try {
    const first = finding('find-1', at - hour)
    store.append(observation('obs-1', at - 2 * hour, 0))
    store.append(observation('obs-2', at - hour, 127))
    store.append(first)
    store.append({ type: 'finding-update', id: 'upd-1', at, findingId: first.id, status: 'fixed', lastChecked: at, resolvedAt: at })

    const result = queryTimeline(store, 'tcp:3306', 7, at)
    assert.deepEqual(
      result.points.map((point) => point.kind),
      ['observed', 'observed', 'finding', 'resolved'],
    )
    const text = renderTimeline(result)
    assert.match(text, /读到/)
    assert.match(text, /发现/)
    assert.match(text, /已恢复/)
    assert.match(text, /2 次读取/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty window is called an evidence gap, not a quiet day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-timeline2-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  try {
    const text = renderTimeline(queryTimeline(store, 'tcp:3306', 7, at))
    assert.match(text, /没有读到这个 key/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
