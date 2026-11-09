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
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = 'nightwatch'
const dshBin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const bundleDir = join(root, 'packages', 'nightwatch-host')

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
async function openCore(home) {
  const core = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'inspect.js')).href)
  const { WatchStore } = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'store.js')).href)
  const store = new WatchStore(join(home, 'watch.jsonl'), join(home, 'watch.db'))
  return { core, store }
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
    const result = core.runInspection({ store, config: coreConfig(home), trigger: 'tick' })
    console.log(core.formatInspection(result))
    if (result.health === 'failed') process.exitCode = 1
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
  const { store } = await openCore(home)
  try {
    const { timelineText } = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'timeline.js')).href)
    console.log(timelineText(store, key, Number(days ?? 7), Date.now()))
  } finally {
    store.close()
  }
}

const command = process.argv[2] ?? 'web'
try {
  const at = place(process.env.NIGHTWATCH_HOME ?? join(root, '.nightwatch-home'))
  if (command === 'setup') {
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
  } else {
    throw new Error(`unknown command ${command}`)
  }
} catch (error) {
  console.error(`nightwatch: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
