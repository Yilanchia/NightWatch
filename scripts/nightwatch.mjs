#!/usr/bin/env node
// Nightwatch's launcher. Nightwatch is a standalone defence agent: its own home, profile,
// bundle and port. It never reads or writes another project's `.fairy-home`; the only shared
// thing is `@fairy/guard`, consumed read-only from its own repository.
//
//   node scripts/nightwatch.mjs setup   create the isolated `nightwatch` profile and install the bundle
//   node scripts/nightwatch.mjs dump    print the composed plugin tree
//   node scripts/nightwatch.mjs web     serve the Web UI on Nightwatch's own port (default 3091)
//   node scripts/nightwatch.mjs smoke   boot once in a throwaway home and check the plugin loads
//   node scripts/nightwatch.mjs tick    run one full inspection with no session and no model
//   node scripts/nightwatch.mjs baseline  accept the current state as the reference (owner action)
//   node scripts/nightwatch.mjs timeline  show one fact's reads/findings/resolution over a window
//   node scripts/nightwatch.mjs health    last run, last success, blind spots and stale collectors
//   node scripts/nightwatch.mjs daemon    built-in scheduler (foreground; catch-up once, no overlap)
//   node scripts/nightwatch.mjs export    signed cross-node summary (findings + health, no raw facts)
//   node scripts/nightwatch.mjs verify    check a bundle signature
//   node scripts/nightwatch.mjs ingest    add a bundle to a coordinator state file
//   node scripts/nightwatch.mjs register  explicitly accept a node's public key (before ingest)
//   node scripts/nightwatch.mjs serve     coordinator HTTP endpoint for signed bundles (local prototype)
//   node scripts/nightwatch.mjs push      send a bundle to a coordinator endpoint
//   node scripts/nightwatch.mjs correlate group open findings across nodes (same fact key)
//   node scripts/nightwatch.mjs selfcheck boot the explicit minimal host and assert its tool list
//   node scripts/nightwatch.mjs analyst   run a bounded, read-only investigation with a model
//   node scripts/nightwatch.mjs approve   issue a one-time owner approval for one repair proposal
//   node scripts/nightwatch.mjs acceptance  audit daily runs/reports + rebuild consistency from the log
//   node scripts/nightwatch.mjs version   print the version
//   node scripts/nightwatch.mjs panel     read-only local dashboard (SSH tunnel; no writes)
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = 'nightwatch'
const standaloneProfile = 'nightwatch-standalone'
const analystProfile = 'nightwatch-analyst'
const dshBin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const bundleDir = join(root, 'packages', 'nightwatch-host')
const standaloneDir = join(root, 'packages', 'nightwatch-standalone')
const analystDir = join(root, 'packages', 'nightwatch-analyst')

/** The project's `.env` (gitignored), for this child process only. */
function ownEnv() {
  const file = join(root, '.env')
  if (!existsSync(file)) return {}
  return Object.fromEntries(Object.entries(parseEnv(readFileSync(file, 'utf8'))).filter(([, value]) => value !== ''))
}

function place(home) {
  if (/[^\x00-\x7f]/u.test(home)) {
    throw new Error(`Nightwatch home must be an ASCII path, got ${home}`)
  }
  return {
    home,
    env: {
      ...ownEnv(),
      ...process.env,
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(home, 'agents'),
      DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE ?? 'DISABLED',
      NIGHTWATCH_AUDIT_PATH: join(home, 'audit.jsonl'),
      NIGHTWATCH_EVIDENCE_PATH: join(home, 'watch.jsonl'),
      NIGHTWATCH_DB_PATH: join(home, 'watch.db'),
      NIGHTWATCH_REPORT_DIR: join(home, 'watch-reports'),
    },
  }
}

function start(at, args, { capture = false } = {}) {
  const child = spawn(process.execPath, [dshBin, ...args], {
    env: at.env,
    cwd: root,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  const run = { child, output: '', exited: false }
  if (capture) {
    child.stdout.on('data', (chunk) => (run.output += chunk))
    child.stderr.on('data', (chunk) => (run.output += chunk))
  }
  run.done = new Promise((resolvePromise, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => {
      run.exited = true
      resolvePromise(code ?? 1)
    })
  })
  return run
}

async function setup(at, { quiet = false } = {}) {
  const manifest = join(at.home, 'profiles', profile, 'package.json')
  if (!existsSync(manifest)) {
    const run = start(at, ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], { capture: true })
    if ((await run.done) !== 0) throw new Error(`creating the profile failed:\n${run.output}`)
  }
  const bundles = JSON.parse(readFileSync(manifest, 'utf8')).dsh?.profile?.bundles ?? []
  if (!bundles.includes('@nightwatch/host')) {
    const run = start(at, ['plugin', '--profile', profile, 'add', `link:${bundleDir}`], { capture: quiet })
    if ((await run.done) !== 0) throw new Error(`installing @nightwatch/host failed:\n${run.output}`)
  }
}

/** The minimal host: a hand-written profile whose whole tree is @nightwatch/standalone. */
async function setupStandalone(at) {
  const dir = join(at.home, 'profiles', standaloneProfile)
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      manifest,
      `${JSON.stringify({ name: 'dsh-profile-nightwatch-standalone', private: true, dsh: { profile: { bundles: ['@nightwatch/standalone'] } } }, null, 2)}\n`,
      'utf8',
    )
  }
  const installed = join(dir, 'node_modules', '@nightwatch', 'standalone', 'package.json')
  if (!existsSync(installed)) {
    const run = start(at, ['plugin', '--profile', standaloneProfile, 'add', `link:${standaloneDir}`], { capture: true })
    if ((await run.done) !== 0) throw new Error(`installing @nightwatch/standalone failed:\n${run.output}`)
  }
}

async function setupAnalyst(at) {
  const dir = join(at.home, 'profiles', analystProfile)
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) {
    const run = start(at, ['--profile', analystProfile, '--from-default-profile', 'headless', '--dump-config'], { capture: true })
    if ((await run.done) !== 0) throw new Error(`creating the analyst profile failed:\n${run.output}`)
  }
  const installed = join(dir, 'node_modules', '@nightwatch', 'analyst', 'package.json')
  if (!existsSync(installed)) {
    const run = start(at, ['plugin', '--profile', analystProfile, 'add', `link:${analystDir}`], { capture: true })
    if ((await run.done) !== 0) throw new Error(`installing @nightwatch/analyst failed:\n${run.output}`)
  }
}

/** Run one bounded, read-only investigation. The deterministic tick/daemon never depend on it. */
async function analyst(home, prompt) {
  if (!prompt) throw new Error('analyst 需要一句任务，例如 "看看最近有什么异常"')
  const at = place(home)
  await setupAnalyst(at)
  const env = {
    ...at.env,
    NIGHTWATCH_PROJECTION: at.env.NIGHTWATCH_PROJECTION ?? '1',
    NIGHTWATCH_NOTE_PATH: join(home, 'investigations.jsonl'),
    NIGHTWATCH_BUDGET_CALLS: at.env.NIGHTWATCH_BUDGET_CALLS ?? '20',
    NIGHTWATCH_BUDGET_MINUTES: at.env.NIGHTWATCH_BUDGET_MINUTES ?? '5',
    NIGHTWATCH_BUDGET_BYTES: at.env.NIGHTWATCH_BUDGET_BYTES ?? '262144',
  }
  process.exitCode = await start({ ...at, env }, ['--profile', analystProfile, prompt]).done
}

/** Boot the minimal host once and assert that only the watch_* tools are reachable. */
async function selfcheck() {
  const home = mkdtempSync(join(tmpdir(), 'nightwatch-selfcheck-'))
  const at = place(home)
  try {
    await setupStandalone(at)
    const gated = { ...at, env: { ...at.env, NIGHTWATCH_SELFCHECK: '1' } }
    const run = start(gated, ['--profile', standaloneProfile], { capture: true })
    const timedOut = new Promise((_, reject) => setTimeout(() => reject(new Error('selfcheck timed out after 60s')), 60_000))
    let code
    try {
      code = await Promise.race([run.done, timedOut])
    } finally {
      if (!run.exited) run.child.kill()
    }
    const match = /nightwatch-selfcheck (\{.*\})/.exec(run.output)
    if (!match) throw new Error(`selfcheck 没有输出结论：\n${run.output.split('\n').slice(-25).join('\n')}`)
    const result = JSON.parse(match[1])
    const gateBad = !result.gate || !result.gate.pass
    const dangerous = result.dangerousReachable ?? []
    if (code !== 0 || result.extra.length > 0 || result.missing.length > 0 || dangerous.length > 0 || gateBad) {
      throw new Error(
        `selfcheck 失败（exit ${code}）：extra=[${result.extra.join(', ')}] missing=[${result.missing.join(', ')}]` +
          ` dangerous=[${dangerous.join(', ')}] gate=${JSON.stringify(result.gate ?? null)}${result.error ? ` error=${result.error}` : ''}`,
      )
    }
    console.log(`selfcheck passed — tools: ${result.tools.join(', ')}`)
    console.log(`  工具面：只有 watch_* 只读工具，危险能力可达 ${dangerous.length ? dangerous.join('、') : '无'}`)
    console.log(`  强制拒绝门：${result.gate.pass ? '生效（destructive 被挡下，工具体未执行）' : '未生效'}`)
    console.log(`  guard 名称判定盲区：${result.guardNameBlind ? '存在——routine 名的写操作未被拦（需 PDP）' : '已关闭——PDP 按动作拦下了 routine 名写工具'}`)
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

async function waitFor(what, read, run, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (run.exited) throw new Error(`dsh exited before ${what}:\n${run.output}`)
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}:\n${run.output}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
}

async function smoke() {
  const at = place(mkdtempSync(join(tmpdir(), 'nightwatch-smoke-')))
  try {
    await setup(at, { quiet: true })
    const run = start(at, ['--profile', profile, '--no-open', '--port', '0'], { capture: true })
    try {
      await waitFor('the Web server', () => /http:\/\/127\.0\.0\.1:\d+\//u.test(run.output), run, 120_000)
      const problems = run.output.split('\n').filter((line) => /@nightwatch\/|@fairy\/|nightwatch-(agent|host)/u.test(line))
      if (problems.length > 0) throw new Error(`Nightwatch plugins reported problems:\n${problems.join('\n')}`)
      console.log(`nightwatch: smoke passed — the Web server bound and the agent loaded in ${at.home}`)
    } finally {
      run.child.kill()
      await run.done
    }
  } finally {
    rmSync(at.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

/**
 * The framework-free core, for the commands that must run with no session and no model.
 * `inspect.js` / `store.js` never import DSH.
 */
async function openCore(home, { readOnly = false } = {}) {
  const core = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'inspect.js')).href)
  const { WatchStore } = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'store.js')).href)
  const store = new WatchStore(join(home, 'watch.jsonl'), join(home, 'watch.db'), { readOnly })
  return { core, store }
}

/** Read-only commands must work while the daemon holds the writer lock; fall back only if no view exists. */
async function openReadCore(home) {
  try {
    return await openCore(home, { readOnly: true })
  } catch {
    return openCore(home)
  }
}

function coreConfig(home) {
  return {
    evidencePath: join(home, 'watch.jsonl'),
    databasePath: join(home, 'watch.db'),
    reportDir: join(home, 'watch-reports'),
    ports: process.env.NIGHTWATCH_PORTS !== '0',
    ssh: process.env.NIGHTWATCH_SSH !== '0',
    backup: process.env.NIGHTWATCH_BACKUP !== '0',
    backupPaths: (process.env.NIGHTWATCH_BACKUP_PATHS ?? '').split(';').filter(Boolean),
    backupStaleHours: Number(process.env.NIGHTWATCH_BACKUP_STALE_HOURS ?? 36),
    observationValidHours: Number(process.env.NIGHTWATCH_VALID_HOURS ?? 26),
    ...(process.env.NIGHTWATCH_SSHD_CONFIG ? { sshdConfig: process.env.NIGHTWATCH_SSHD_CONFIG } : {}),
    ...(process.env.NIGHTWATCH_AUTHORIZED_KEYS ? { authorizedKeys: process.env.NIGHTWATCH_AUTHORIZED_KEYS } : {}),
  }
}

/**
 * One full inspection, the same pipeline the tools use, but with no DSH session and no model.
 * This is the piece a cron job or systemd timer can call, and the M0 evidence that the product
 * does not depend on the agent runtime.
 */
async function tick(home) {
  const { core, store } = await openCore(home)
  try {
    if (store.recovery) {
      console.warn(`nightwatch: 日志尾部有半行，已隔离到 ${store.recovery.tornPath}（${store.recovery.tornBytes} 字节），本次从最后一条完整事件继续`)
    }
    const result = core.runInspection({ store, config: coreConfig(home) }, { trigger: 'tick' })
    console.log(core.formatInspection(result))
    // 0 = every collector read; 2 = something was partial; 1 = at least one collector failed.
    process.exitCode = result.health === 'ok' ? 0 : result.health === 'partial' ? 2 : 1
  } finally {
    store.close()
  }
}

/** Accept the machine as it is now. A deliberate owner action, never automatic. */
async function baseline(home) {
  const { core, store } = await openCore(home)
  try {
    console.log(core.takeBaseline({ store, config: coreConfig(home) }))
  } finally {
    store.close()
  }
}

/** One fact's history over a window, from the evidence view. */
async function timeline(home, key, days) {
  const { store } = await openReadCore(home)
  try {
    const { timelineText } = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'timeline.js')).href)
    console.log(timelineText(store, key, Number(days ?? 7), Date.now()))
  } finally {
    store.close()
  }
}

/** When did it last work, what didn't we read, is the data still usable. */
async function health(home) {
  const { core, store } = await openReadCore(home)
  try {
    const summary = core.inspectionHealth(store, coreConfig(home), Date.now())
    const lines = [core.formatHealth(summary)]
    const minutes = Number(process.env.NIGHTWATCH_INTERVAL_MINUTES ?? 0)
    if (summary.lastRun && minutes > 0) {
      const time = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'time.js')).href)
      lines.push(`下一轮约：${time.localStamp(summary.lastRun.at + minutes * 60_000)}（间隔 ${minutes} 分钟）`)
    }
    console.log(lines.join('\n'))
  } finally {
    store.close()
  }
}

/** Signed summary bundle: findings + run health, no raw facts or evidence. */
async function exportBundle(home, days) {
  const { store } = await openReadCore(home)
  try {
    const identity = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'identity.js')).href)
    const exporter = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'export.js')).href)
    const nodeIdentity = identity.ensureIdentity(home)
    const statePath = join(home, 'export-state.json')
    const prior = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { seq: 0 }
    const seq = Number(prior.seq ?? 0) + 1
    const now = Date.now()
    const bundle = exporter.buildBundle(store, coreConfig(home), nodeIdentity, {
      now,
      days: Number(days ?? 7),
      seq,
      platform: process.platform,
    })
    writeFileSync(statePath, `${JSON.stringify({ seq, lastExportAt: now }, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify(bundle, null, 2))
  } finally {
    store.close()
  }
}

async function verifyBundleFile(file) {
  const exporter = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'export.js')).href)
  const bundle = JSON.parse(readFileSync(file, 'utf8'))
  const result = exporter.verifyBundle(bundle)
  console.log(result.ok ? `签名有效（节点 ${bundle.payload.node.id}）` : `校验失败：${result.reason}`)
  if (!result.ok) process.exitCode = 1
}

/** Add one signed bundle to a coordinator state file (verify + dedupe, no raw evidence). */
async function ingestCommand(stateFile, bundleFile) {
  const coordinator = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'coordinator.js')).href)
  const now = Date.now()
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : coordinator.emptyState(now)
  const bundle = JSON.parse(readFileSync(bundleFile, 'utf8'))
  const result = coordinator.ingestBundle(state, bundle, now)
  if (!result.ok) {
    console.error(`摄入失败：${result.reason}`)
    process.exitCode = 1
    return
  }
  const temporary = `${stateFile}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(result.state, null, 2)}\n`, 'utf8')
  renameSync(temporary, stateFile)
  console.log(`已摄入 ${result.nodeId}：新增 ${result.added} 条、更新 ${result.updated} 条；状态 ${stateFile}`)
}

/** Explicit owner action: trust this node's public key before accepting its findings. */
async function registerCommand(stateFile, bundleFile) {
  const coordinator = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'coordinator.js')).href)
  const now = Date.now()
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : coordinator.emptyState(now)
  const bundle = JSON.parse(readFileSync(bundleFile, 'utf8'))
  const result = coordinator.registerNode(state, bundle, now)
  if (!result.ok) {
    console.error(`登记失败：${result.reason}`)
    process.exitCode = 1
    return
  }
  const temporary = `${stateFile}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(result.state, null, 2)}\n`, 'utf8')
  renameSync(temporary, stateFile)
  console.log(
    result.alreadyRegistered
      ? `节点 ${result.nodeId} 已登记（公钥一致）`
      : `已登记节点 ${result.nodeId}（能力：${result.state.nodes[result.nodeId]?.capabilities.collectors.join('/')}；平台 ${result.state.nodes[result.nodeId]?.capabilities.platform}）`,
  )
}

/** Group open findings by fact key and mark groups seen on more than one node. */
async function correlateCommand(stateFile) {
  const coordinator = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'coordinator.js')).href)
  if (!existsSync(stateFile)) {
    console.error(`状态文件不存在：${stateFile}`)
    process.exitCode = 1
    return
  }
  const groups = coordinator.correlate(JSON.parse(readFileSync(stateFile, 'utf8')))
  if (groups.length === 0) {
    console.log('没有未关闭的发现。')
    return
  }
  for (const group of groups) {
    console.log(`${group.crossNode ? '[跨端] ' : ''}${group.key}（${group.kind}，${group.nodes.length} 个节点：${group.nodes.join(', ')}）`)
    for (const finding of group.findings) console.log(`  - ${finding.nodeId} [${finding.severity}] ${finding.title}（${finding.status}）`)
  }
}

/** Local coordinator endpoint: POST /v1/bundle, GET /v1/status. Not production TLS. */
async function serveCommand(stateFile, port, host) {
  const transport = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'transport.js')).href)
  const server = await transport.startCoordinatorServer({
    statePath: stateFile,
    ...(port ? { port: Number(port) } : {}),
    ...(host ? { host } : {}),
  })
  console.log(`coordinator listening ${server.url} (state ${stateFile})`)
  await new Promise((resolve) => {
    const stop = () => {
      server.close().then(resolve, resolve)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

/** Send one bundle to a coordinator endpoint. */
async function pushCommand(url, bundleFile) {
  const bundle = JSON.parse(readFileSync(bundleFile, 'utf8'))
  const target = `${url.replace(/\/+$/u, '')}/v1/bundle`
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  })
  const body = await response.json()
  if (!response.ok || !body.ok) {
    console.error(`推送失败（${response.status}）：${body.reason ?? '未知'}`)
    process.exitCode = 1
    return
  }
  console.log(`已推送 ${body.nodeId}：新增 ${body.added} 条、更新 ${body.updated} 条${body.staleSeq ? '（旧序号）' : ''}`)
}

/** Explicit owner approval: bind a one-time grant to one proposal and the file's current state. */
async function approveCommand(home, proposalId, minutes) {
  if (!proposalId) throw new Error('approve 需要 <home> <proposalId> [minutes]')
  const { store } = await openReadCore(home)
  try {
    const proposal = store.proposalById(proposalId)
    if (!proposal) throw new Error(`没有找到提案 ${proposalId}。先跑 watch_propose_fix。`)
    const config = coreConfig(home)
    const sshd =
      config.sshdConfig ??
      (process.platform === 'win32'
        ? join(process.env.ProgramData ?? 'C:\\ProgramData', 'ssh', 'sshd_config')
        : '/etc/ssh/sshd_config')
    const content = readFileSync(sshd, 'utf8')
    const approval = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'approval.js')).href)
    const key = approval.ensureApprovalKey(home)
    const grant = approval.createGrant(key, proposal, {
      stateFingerprint: approval.stateFingerprint(content),
      approver: 'owner',
      now: Date.now(),
      ttlMinutes: Number(minutes ?? 15),
    })
    approval.appendGrant(home, grant)
    console.log(`已生成一次性审批 ${grant.id}`)
    console.log(`提案：${proposal.id}；文件：${sshd}；绑定状态 ${grant.subject.stateFingerprint.slice(0, 12)}…`)
    console.log(`有效期至：${new Date(grant.expiresAt).toISOString()}`)
    console.log('执行时把 approvalId 交给 watch_apply_fix；这份审批只能使用一次。')
  } finally {
    store.close()
  }
}

/** Audit what is already on disk: daily runs/reports, last health, and a rebuild from the log. */
async function acceptanceCommand(home, days) {
  const { store } = await openReadCore(home)
  try {
    const acceptance = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'acceptance.js')).href)
    const result = acceptance.runAcceptance(store, {
      now: Date.now(),
      days: Number(days ?? 7),
      evidencePath: join(home, 'watch.jsonl'),
      reportDir: join(home, 'watch-reports'),
    })
    for (const check of result.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}：${check.detail}`)
    console.log(result.pass ? '验收通过' : '验收未通过')
    process.exitCode = result.pass ? 0 : 1
  } finally {
    store.close()
  }
}

function versionCommand() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  console.log(`nightwatch ${pkg.version ?? '0.0.0'}`)
}

/** Read-only local panel over the materialized view (reach it through an SSH tunnel). */
async function panelCommand(home, port, host) {
  const { store } = await openReadCore(home)
  try {
    const panel = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'panel.js')).href)
    const listenPort = Number(port ?? 3092)
    const server = await panel.startPanel({
      store,
      config: coreConfig(home),
      port: listenPort,
      ...(host ? { host } : {}),
    })
    console.log(`panel ${server.url}（只读）`)
    console.log(`SSH 隧道：ssh -L ${listenPort}:127.0.0.1:${listenPort} root@<host>，然后打开 http://127.0.0.1:${listenPort}`)
    console.log('Ctrl+C 停止。面板不采集、不执行、不写。')
    await new Promise((resolve) => {
      const stop = () => {
        server.close().then(resolve, resolve)
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
    })
  } finally {
    store.close()
  }
}

/**
 * Built-in scheduler. Holds the evidence lock for its lifetime (so no second writer can interleave),
 * catches up a missed run once after a restart, and never overlaps inspections.
 */
async function daemon(home, intervalMinutes) {
  const schedule = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'schedule.js')).href)
  const time = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'time.js')).href)
  const minutes = Math.max(1, Number(intervalMinutes ?? process.env.NIGHTWATCH_INTERVAL_MINUTES ?? 1440))
  const intervalMs = minutes * 60_000
  const { core, store } = await openCore(home)
  let stopping = false
  const stop = () => {
    stopping = true
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const runOnce = () => {
    try {
      const result = core.runInspection({ store, config: coreConfig(home) }, { trigger: 'scheduler' })
      console.log(core.formatInspection(result))
    } catch (error) {
      console.error(`nightwatch: inspection failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const next = schedule.nextRunAt(store.lastRun()?.at, Date.now(), intervalMs)
    console.log(`nightwatch: next run ${time.localStamp(next)}（间隔 ${minutes} 分钟）`)
  }
  try {
    console.log(`nightwatch: daemon watching ${home}, interval ${minutes} min`)
    if (schedule.isDue(store.lastRun()?.at, Date.now(), intervalMs)) runOnce()
    while (!stopping) {
      const next = schedule.nextRunAt(store.lastRun()?.at, Date.now(), intervalMs)
      const wait = Math.max(1000, next - Date.now())
      await sleep(Math.min(wait, 60_000))
      if (!stopping && schedule.isDue(store.lastRun()?.at, Date.now(), intervalMs)) runOnce()
    }
    console.log('nightwatch: daemon stopped')
  } finally {
    store.close()
  }
}

const command = process.argv[2] ?? 'web'
try {
  const at = place(process.env.NIGHTWATCH_HOME ?? join(root, '.nightwatch-home'))
  if (command === 'version' || command === '--version' || command === '-v') {
    versionCommand()
  } else if (command === 'acceptance') {
    const home = resolve(process.argv[3] ?? process.env.NIGHTWATCH_HOME ?? join(root, '.nightwatch-home'))
    if (/[^\x00-\x7f]/u.test(home)) throw new Error(`Nightwatch home must be an ASCII path, got ${home}`)
    await acceptanceCommand(home, process.argv[4])
  } else if (command === 'panel') {
    const home = resolve(process.argv[3] ?? process.env.NIGHTWATCH_HOME ?? join(root, '.nightwatch-home'))
    if (/[^\x00-\x7f]/u.test(home)) throw new Error(`Nightwatch home must be an ASCII path, got ${home}`)
    await panelCommand(home, process.argv[4], process.argv[5])
  } else if (command === 'setup') {
    await setup(at)
    console.log(`nightwatch: profile ready at ${join(at.home, 'profiles', profile)}`)
  } else if (command === 'dump') {
    await setup(at)
    process.exitCode = await start(at, ['--profile', profile, '--dump-config']).done
  } else if (command === 'web') {
    await setup(at)
    console.log(`nightwatch: home is ${at.home}`)
    const port = process.env.NIGHTWATCH_PORT ?? '3091'
    process.exitCode = await start(at, ['--profile', profile, '--port', port, ...process.argv.slice(3)]).done
  } else if (command === 'smoke') {
    await smoke()
  } else if (command === 'selfcheck') {
    await selfcheck()
  } else if (command === 'analyst') {
    const home = resolve(process.argv[3] ?? process.env.NIGHTWATCH_HOME ?? join(root, '.nightwatch-home'))
    if (/[^\x00-\x7f]/u.test(home)) throw new Error(`Nightwatch home must be an ASCII path, got ${home}`)
    await analyst(home, process.argv.slice(4).join(' '))
  } else if (command === 'approve') {
    const home = resolve(process.argv[3] ?? process.env.NIGHTWATCH_HOME ?? join(root, '.nightwatch-home'))
    if (/[^\x00-\x7f]/u.test(home)) throw new Error(`Nightwatch home must be an ASCII path, got ${home}`)
    await approveCommand(home, process.argv[4], process.argv[5])
  } else if (command === 'tick' || command === 'baseline') {
    const home = resolve(process.argv[3] ?? process.env.NIGHTWATCH_HOME ?? join(root, '.nightwatch-home'))
    if (/[^\x00-\x7f]/u.test(home)) throw new Error(`Nightwatch home must be an ASCII path, got ${home}`)
    await (command === 'tick' ? tick(home) : baseline(home))
  } else if (command === 'timeline') {
    const home = resolve(process.argv[3] ?? process.env.NIGHTWATCH_HOME ?? join(root, '.nightwatch-home'))
    if (/[^\x00-\x7f]/u.test(home)) throw new Error(`Nightwatch home must be an ASCII path, got ${home}`)
    const key = process.argv[4]
    if (!key) throw new Error('timeline 需要 key，例如 tcp:3306 或 ssh:passwordauthentication')
    await timeline(home, key, process.argv[5])
  } else if (command === 'health') {
    const home = resolve(process.argv[3] ?? process.env.NIGHTWATCH_HOME ?? join(root, '.nightwatch-home'))
    if (/[^\x00-\x7f]/u.test(home)) throw new Error(`Nightwatch home must be an ASCII path, got ${home}`)
    await health(home)
  } else if (command === 'daemon') {
    const home = resolve(process.argv[3] ?? process.env.NIGHTWATCH_HOME ?? join(root, '.nightwatch-home'))
    if (/[^\x00-\x7f]/u.test(home)) throw new Error(`Nightwatch home must be an ASCII path, got ${home}`)
    await daemon(home, process.argv[4])
  } else if (command === 'export') {
    const home = resolve(process.argv[3] ?? process.env.NIGHTWATCH_HOME ?? join(root, '.nightwatch-home'))
    if (/[^\x00-\x7f]/u.test(home)) throw new Error(`Nightwatch home must be an ASCII path, got ${home}`)
    await exportBundle(home, process.argv[4])
  } else if (command === 'verify') {
    const file = process.argv[3]
    if (!file) throw new Error('verify 需要 bundle 文件路径')
    await verifyBundleFile(resolve(file))
  } else if (command === 'ingest') {
    const stateFile = process.argv[3]
    const bundleFile = process.argv[4]
    if (!stateFile || !bundleFile) throw new Error('ingest 需要 <state.json> <bundle.json>')
    await ingestCommand(resolve(stateFile), resolve(bundleFile))
  } else if (command === 'register') {
    const stateFile = process.argv[3]
    const bundleFile = process.argv[4]
    if (!stateFile || !bundleFile) throw new Error('register 需要 <state.json> <bundle.json>')
    await registerCommand(resolve(stateFile), resolve(bundleFile))
  } else if (command === 'correlate') {
    const stateFile = process.argv[3]
    if (!stateFile) throw new Error('correlate 需要 <state.json>')
    await correlateCommand(resolve(stateFile))
  } else if (command === 'serve') {
    const stateFile = process.argv[3]
    if (!stateFile) throw new Error('serve 需要 <state.json> [port] [host]')
    await serveCommand(resolve(stateFile), process.argv[4], process.argv[5])
  } else if (command === 'push') {
    const url = process.argv[3]
    const bundleFile = process.argv[4]
    if (!url || !bundleFile) throw new Error('push 需要 <url> <bundle.json>')
    await pushCommand(url, resolve(bundleFile))
  } else {
    throw new Error(`unknown command ${command}`)
  }
} catch (error) {
  console.error(`nightwatch: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
