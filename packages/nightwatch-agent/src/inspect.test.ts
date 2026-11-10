import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Runner } from './collect.js'
import { inspectionHealth, runInspection, takeBaseline, writeReport } from './inspect.js'
import { WatchStore } from './store.js'
import type { WatchConfig } from './tools.js'
import type { Baseline, Observation } from './types.js'

const at = 1_800_000_000_000

const PORTS = [
  'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
  'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))',
].join('\n')

const PORTS_WITH_3306 = [PORTS, 'LISTEN 0 128 *:3306 *:* users:(("mysqld",pid=2,fd=20))'].join('\n')

interface SetupOptions {
  readonly ports?: boolean
  readonly ssh?: boolean
  readonly sshdText?: string
  readonly sshdConfig?: string
  readonly authorizedKeys?: string
}

function setup(runner: Runner, options: SetupOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-inspect-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  const config: WatchConfig = {
    evidencePath: join(dir, 'watch.jsonl'),
    databasePath: join(dir, 'watch.db'),
    reportDir: join(dir, 'reports'),
    ports: options.ports ?? true,
    ssh: options.ssh ?? false,
    backup: false,
    backupPaths: [],
    backupStaleHours: 36,
    ...(options.sshdConfig ? { sshdConfig: options.sshdConfig } : {}),
    ...(options.authorizedKeys ? { authorizedKeys: options.authorizedKeys } : {}),
  }
  const context = { store, config, platform: 'linux' as const, now: () => at, runner }
  return {
    dir,
    store,
    context,
    cleanup: () => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const ssFailed: Runner = () => ({ exit: 127, stdout: '', stderr: 'ss: command not found' })

function ssReturns(output: string): Runner {
  return (command) => (command === 'ss' ? { exit: 0, stdout: output, stderr: '' } : { exit: 127, stdout: '', stderr: '' })
}

test('asking for the report first still discovers a weak SSH setting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-ssh-'))
  const sshd = join(dir, 'sshd_config')
  const keys = join(dir, 'authorized_keys')
  writeFileSync(sshd, 'PasswordAuthentication yes\nPermitRootLogin yes\n', 'utf8')
  writeFileSync(keys, '', 'utf8')
  const { context, cleanup } = setup(ssFailed, { ports: false, ssh: true, sshdConfig: sshd, authorizedKeys: keys })
  try {
    const result = runInspection(context, { trigger: 'report' })

    assert.equal(result.newFindings.length, 2)
    assert.ok(existsSync(result.reportPath))
    const text = readFileSync(result.reportPath, 'utf8')
    assert.match(text, /守夜人日报/)
    assert.match(text, /SSH 允许密码登录/)
    assert.match(text, /SSH 允许 root 登录/)
    assert.doesNotMatch(text, /今天没有值得单独说的变化/)
  } finally {
    cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed collector is a blind spot, not a quiet day', () => {
  const { context, cleanup } = setup(ssFailed)
  try {
    const result = runInspection(context)

    assert.equal(result.health, 'failed')
    assert.deepEqual(result.blindSpots, ['ports（读取失败）'])
    const text = readFileSync(result.reportPath, 'utf8')
    assert.match(text, /检查盲区/)
    assert.match(text, /不能当成"没有变化"/)
    assert.doesNotMatch(text, /今天没有值得单独说的变化/)
  } finally {
    cleanup()
  }
})

test('without a baseline ports are not reported as new, and the report says why', () => {
  const { context, cleanup } = setup(ssReturns(PORTS))
  try {
    const result = runInspection(context)

    assert.equal(result.newFindings.length, 0)
    const text = readFileSync(result.reportPath, 'utf8')
    assert.match(text, /还没有基线，端口变化未评估/)
    assert.doesNotMatch(text, /新开的监听端口/)
  } finally {
    cleanup()
  }
})

test('baseline plus a new port is found, and a second run does not duplicate it', () => {
  const { context, store, cleanup } = setup(ssReturns(PORTS_WITH_3306))
  try {
    const baseline: Baseline = {
      type: 'baseline',
      id: 'base-1',
      at,
      host: 'host',
      facts: [{ kind: 'listen_port', key: 'tcp:22', value: '0.0.0.0:22', detail: '0.0.0.0:22' }],
      observationIds: [],
    }
    store.append(baseline)

    const first = runInspection(context)
    assert.equal(first.newFindings.length, 1)
    assert.equal(first.newFindings[0]!.key, 'tcp:3306')
    const firstText = readFileSync(first.reportPath, 'utf8')
    assert.match(firstText, /新开的监听端口/)
    assert.match(firstText, /3306/)

    const second = runInspection(context)
    assert.equal(second.newFindings.length, 0)
    assert.equal(second.openFindings.length, 1)
    const secondText = readFileSync(second.reportPath, 'utf8')
    assert.match(secondText, /未关闭/)
    assert.match(secondText, /3306/)
  } finally {
    cleanup()
  }
})

test('an unreadable sshd_config is partial, not a pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-partial-'))
  const keys = join(dir, 'authorized_keys')
  writeFileSync(keys, '', 'utf8')
  const { context, cleanup } = setup(ssFailed, {
    ports: false,
    ssh: true,
    sshdConfig: join(dir, 'does-not-exist'),
    authorizedKeys: keys,
  })
  try {
    const result = runInspection(context)
    assert.equal(result.health, 'partial')
    assert.deepEqual(result.blindSpots, ['ssh（部分未读全）'])
  } finally {
    cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed read says why, in short machine terms', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-reason-'))
  const keys = join(dir, 'authorized_keys')
  writeFileSync(keys, '', 'utf8')
  const { context, cleanup } = setup(ssFailed, {
    ports: true,
    ssh: true,
    sshdConfig: join(dir, 'missing-sshd_config'),
    authorizedKeys: keys,
  })
  try {
    const result = runInspection(context)
    const ports = result.observations.find((observation) => observation.collector === 'ports')!
    const ssh = result.observations.find((observation) => observation.collector === 'ssh')!
    assert.match(ports.error ?? '', /退出码 127/)
    assert.match(ssh.error ?? '', /文件不存在/)
    const text = readFileSync(result.reportPath, 'utf8')
    assert.match(text, /原因：/)
  } finally {
    cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed read older than the validity window is reported as stale data', () => {
  const { context, store, cleanup } = setup(ssFailed)
  try {
    store.append({
      type: 'observation',
      id: 'obs-old',
      at: at - 30 * 3_600_000,
      host: 'host',
      collector: 'ports',
      facts: [{ kind: 'listen_port', key: 'tcp:22', value: '0.0.0.0:22' }],
      evidence: [{ command: 'ss -ltnp', exit: 0, outputSha256: 'x' }],
      status: 'ok',
    })
    const result = runInspection(context, { now: at })
    assert.ok(result.notes.some((note) => note.includes('数据已过期')))
    assert.match(readFileSync(result.reportPath, 'utf8'), /数据已过期/)
  } finally {
    cleanup()
  }
})

test('a partial baseline is refused instead of being stored half-read', () => {
  const { context, store, cleanup } = setup(ssFailed)
  try {
    const message = takeBaseline(context)
    assert.match(message, /基线不完整/)
    assert.equal(store.latestBaseline(), undefined)
  } finally {
    cleanup()
  }
})

test('each run is recorded and health separates last run from last all-green run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-runs-'))
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
  const runner: Runner = (command) =>
    command === 'ss'
      ? failing
        ? { exit: 127, stdout: '', stderr: 'no ss' }
        : { exit: 0, stdout: PORTS, stderr: '' }
      : { exit: 127, stdout: '', stderr: '' }
  const context = { store, config, platform: 'linux' as const, now: () => at, runner }
  try {
    const first = runInspection(context, { now: at })
    assert.equal(store.lastRun()?.id, first.runId)
    assert.equal(store.lastRun()?.health, 'ok')
    assert.equal(store.lastOkRun()?.id, first.runId)

    failing = true
    const second = runInspection(context, { now: at + 30 * 3_600_000 })
    assert.equal(second.health, 'failed')
    assert.equal(store.lastRun()?.id, second.runId)
    assert.equal(store.lastOkRun()?.id, first.runId)

    const summary = inspectionHealth(store, config, at + 30 * 3_600_000)
    assert.equal(summary.lastRun?.id, second.runId)
    assert.equal(summary.lastOkRun?.id, first.runId)
    assert.ok(summary.blindSpots.length > 0)
    assert.ok(summary.stale.some((item) => item.startsWith('ports')))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a report for a past day uses that day observations, not today reading', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-history-'))
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
  const dayOne = new Date(2026, 10, 7, 12).getTime()
  const dayTwo = new Date(2026, 10, 8, 12).getTime()
  const observation = (at: number, id: string, key: string): Observation => ({
    type: 'observation',
    id,
    at,
    host: 'host',
    collector: 'ports',
    facts: [{ kind: 'listen_port', key, value: `${key.split(':')[1]}:22` }],
    evidence: [{ command: 'ss -ltnp', exit: 0, outputSha256: 'x' }],
  })
  store.append(observation(dayOne, 'obs-one', 'tcp:22'))
  store.append(observation(dayTwo, 'obs-two', 'tcp:3306'))
  const context = { store, config, platform: 'linux' as const, now: () => dayTwo, runner: ssFailed }
  try {
    const message = writeReport(context, '2026-11-07')
    const path = message.match(/日报已写到 (.+?)（/)?.[1]
    assert.ok(path)
    const text = readFileSync(path, 'utf8')
    assert.match(text, /2026-11-07/)
    assert.doesNotMatch(text, /3306/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
