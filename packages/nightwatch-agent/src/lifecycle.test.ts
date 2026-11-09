import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Runner } from './collect.js'
import { runInspection } from './inspect.js'
import { WatchStore } from './store.js'
import type { WatchConfig } from './tools.js'
import type { Baseline } from './types.js'

const t1 = 1_800_000_000_000
const hour = 3_600_000

const PORTS = [
  'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
  'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))',
].join('\n')

const PORTS_WITH_3306 = [PORTS, 'LISTEN 0 128 *:3306 *:* users:(("mysqld",pid=2,fd=20))'].join('\n')

interface SetupOptions {
  readonly ports?: boolean
  readonly ssh?: boolean
}

function setup(runner: Runner, options: SetupOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-life-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  const sshd = join(dir, 'sshd_config')
  const keys = join(dir, 'authorized_keys')
  writeFileSync(keys, '', 'utf8')
  const config: WatchConfig = {
    evidencePath: join(dir, 'watch.jsonl'),
    databasePath: join(dir, 'watch.db'),
    reportDir: join(dir, 'reports'),
    ports: options.ports ?? false,
    ssh: options.ssh ?? true,
    backup: false,
    backupPaths: [],
    backupStaleHours: 36,
    sshdConfig: sshd,
    authorizedKeys: keys,
  }
  const context = { store, config, platform: 'linux' as const, now: () => t1, runner }
  return {
    dir,
    store,
    context,
    sshd,
    keys,
    cleanup: () => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const noCommand: Runner = () => ({ exit: 127, stdout: '', stderr: '' })

test('a risk that stays open keeps its first time and refreshes its last time', () => {
  const { context, sshd, cleanup } = setup(noCommand)
  try {
    writeFileSync(sshd, 'PasswordAuthentication yes\n', 'utf8')
    const first = runInspection(context, { now: t1 })
    assert.equal(first.newFindings.length, 1)
    const id = first.newFindings[0]!.id
    assert.equal(first.newFindings[0]!.firstSeen, t1)

    const second = runInspection(context, { now: t1 + hour })
    assert.equal(second.newFindings.length, 0)
    assert.equal(second.openFindings.length, 1)
    const stored = context.store.findings('id = ?', id)[0]!
    assert.equal(stored.status, 'candidate')
    assert.equal(stored.firstSeen, t1)
    assert.equal(stored.lastSeen, t1 + hour)
    assert.equal(stored.lastChecked, t1 + hour)

    const text = readFileSync(second.reportPath, 'utf8')
    assert.match(text, /SSH 允许密码登录/)
  } finally {
    cleanup()
  }
})

test('fixing the setting closes the finding only after a successful read, and recurrence is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-life2-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  const sshd = join(dir, 'sshd_config')
  const keys = join(dir, 'authorized_keys')
  writeFileSync(keys, '', 'utf8')
  const config: WatchConfig = {
    evidencePath: join(dir, 'watch.jsonl'),
    databasePath: join(dir, 'watch.db'),
    reportDir: join(dir, 'reports'),
    ports: false,
    ssh: true,
    backup: false,
    backupPaths: [],
    backupStaleHours: 36,
    sshdConfig: sshd,
    authorizedKeys: keys,
  }
  const context = { store, config, platform: 'linux' as const, now: () => t1, runner: noCommand }
  try {
    writeFileSync(sshd, 'PasswordAuthentication yes\n', 'utf8')
    const first = runInspection(context, { now: t1 })
    const id = first.newFindings[0]!.id

    writeFileSync(sshd, 'PasswordAuthentication no\n', 'utf8')
    const fixed = runInspection(context, { now: t1 + hour })
    assert.equal(fixed.resolved.length, 1)
    assert.equal(fixed.openFindings.length, 0)
    assert.equal(context.store.findings('id = ?', id)[0]!.status, 'fixed')
    assert.equal(context.store.findings('id = ?', id)[0]!.resolvedAt, t1 + hour)
    assert.match(readFileSync(fixed.reportPath, 'utf8'), /## 已恢复/)

    writeFileSync(sshd, 'PasswordAuthentication yes\n', 'utf8')
    const again = runInspection(context, { now: t1 + 2 * hour })
    assert.equal(again.newFindings.length, 1)
    assert.equal(again.newFindings[0]!.recurrenceOf, id)
    assert.notEqual(again.newFindings[0]!.id, id)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed collector leaves an open risk open instead of resolving it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-life3-'))
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
  let failing = false
  const runner: Runner = (command) => {
    if (command !== 'ss') return { exit: 127, stdout: '', stderr: '' }
    return failing ? { exit: 127, stdout: '', stderr: 'no ss' } : { exit: 0, stdout: PORTS_WITH_3306, stderr: '' }
  }
  const context = { store, config, platform: 'linux' as const, now: () => t1, runner }
  try {
    const baseline: Baseline = {
      type: 'baseline',
      id: 'base-1',
      at: t1,
      host: 'host',
      facts: [{ kind: 'listen_port', key: 'tcp:22', value: '0.0.0.0:22', detail: '0.0.0.0:22' }],
      observationIds: [],
    }
    store.append(baseline)
    const first = runInspection(context, { now: t1 })
    assert.equal(first.newFindings.length, 1)

    failing = true
    const blind = runInspection(context, { now: t1 + hour })
    assert.equal(blind.health, 'failed')
    assert.equal(blind.resolved.length, 0)
    assert.equal(blind.openFindings.length, 1)
    assert.equal(context.store.findings('key = ?', 'tcp:3306')[0]!.status, 'candidate')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('closing the store and replaying the log keeps lifecycle state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-life4-'))
  const sshd = join(dir, 'sshd_config')
  const keys = join(dir, 'authorized_keys')
  writeFileSync(keys, '', 'utf8')
  const config: WatchConfig = {
    evidencePath: join(dir, 'watch.jsonl'),
    databasePath: join(dir, 'watch.db'),
    reportDir: join(dir, 'reports'),
    ports: false,
    ssh: true,
    backup: false,
    backupPaths: [],
    backupStaleHours: 36,
    sshdConfig: sshd,
    authorizedKeys: keys,
  }
  const firstStore = new WatchStore(config.evidencePath, config.databasePath)
  writeFileSync(sshd, 'PasswordAuthentication yes\n', 'utf8')
  const first = runInspection({ store: firstStore, config, platform: 'linux', now: () => t1, runner: noCommand }, { now: t1 })
  const id = first.newFindings[0]!.id
  writeFileSync(sshd, 'PasswordAuthentication no\n', 'utf8')
  runInspection({ store: firstStore, config, platform: 'linux', now: () => t1, runner: noCommand }, { now: t1 + hour })
  firstStore.close()

  const reopened = new WatchStore(config.evidencePath, config.databasePath)
  try {
    assert.equal(reopened.findings('id = ?', id)[0]!.status, 'fixed')
    assert.equal(reopened.findings('id = ?', id)[0]!.resolvedAt, t1 + hour)
    assert.equal(reopened.openFindings().length, 0)
  } finally {
    reopened.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
