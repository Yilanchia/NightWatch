#!/usr/bin/env node
// Egress projection probe (implementation doc task A).
//
// Boots an analyst-style host (headless app + @nightwatch/host), points the model adapter at a local
// fake Messages endpoint, seeds one canary into a finding, and has the fake model ask for
// `watch_report`. Every outbound request body is captured. The probe passes only if:
//   - with projection enabled, no request contains the canary;
//   - with projection disabled (negative control), the canary does leak.
//
// This is a local experiment, not a production endpoint; the fake server never leaves 127.0.0.1.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshBin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const hostDir = join(root, 'packages', 'nightwatch-host')
const profile = 'nw-analyst'
const CANARY = 'NW-CANARY-7f3a9c'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180_000, ...options })
  if (result.error) throw result.error
  return result
}

function sse(response, events) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end()
}

function startFakeModel(captures) {
  const kinds = []
  globalThis.__nwKinds = kinds
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = {}
      }
      const isTitle = typeof parsed.system === 'string' && parsed.system.startsWith('Create a concise title')
      const isAfterTool = body.includes('tool_result')
      captures.push(body)
      kinds.push(isTitle ? 'title' : isAfterTool ? 'afterTool' : 'toolUse')
      if (request.method !== 'POST' || request.url !== '/v1/messages') {
        response.writeHead(404).end()
        return
      }
      const title = isTitle
      const afterTool = isAfterTool
      let events
      if (title) {
        events = textEvents('probe title')
      } else if (afterTool) {
        events = textEvents('done')
      } else {
        events = [
          { type: 'message_start', message: { id: 'msg_probe', usage: { input_tokens: 10, output_tokens: 0 } } },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_probe', name: 'watch_propose_fix', input: { key: 'tcp:4444' } },
          },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ]
      }
      sse(response, events)
    })
  })
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolvePromise({ server, port: address.port })
    })
  })
}

function textEvents(text) {
  return [
    { type: 'message_start', message: { id: 'msg_probe', usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]
}

async function seedCanary(home) {
  const { WatchStore } = await import(pathToFileURL(join(root, 'packages', 'nightwatch-agent', 'dist', 'store.js')).href)
  const store = new WatchStore(join(home, 'watch.jsonl'), join(home, 'watch.db'))
  const at = Date.now()
  store.append({
    type: 'finding',
    id: 'find-egress-canary',
    at,
    kind: 'new_listen_port',
    severity: 'high',
    key: 'tcp:4444',
    title: `新开的监听端口 ${CANARY}`,
    detail: `canary ${CANARY} at /root/.ssh/authorized_keys`,
    epistemic: 'inferred',
    observationId: 'obs-egress',
    status: 'candidate',
    firstSeen: at,
    lastSeen: at,
  })
  store.close()
}

function makeProfile(dshHome) {
  const manifest = join(dshHome, 'profiles', profile, 'package.json')
  if (existsSync(manifest)) return
  const env = { ...process.env, DSH_HOME: dshHome }
  const created = run(process.execPath, [dshBin, '--profile', profile, '--from-default-profile', 'headless', '--dump-config'], { env })
  if (created.status !== 0) throw new Error(`creating analyst profile failed:\n${created.stderr}`)
  const installed = run(process.execPath, [dshBin, 'plugin', '--profile', profile, 'add', `link:${hostDir}`], { env })
  if (installed.status !== 0) throw new Error(`installing @nightwatch/host failed:\n${installed.stderr}`)
}

function runAnalyst(dshHome, nwHome, port, projection) {
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`,
    DEEPSEEK_API_KEY: 'dummy',
    NIGHTWATCH_EVIDENCE_PATH: join(nwHome, 'watch.jsonl'),
    NIGHTWATCH_DB_PATH: join(nwHome, 'watch.db'),
    NIGHTWATCH_REPORT_DIR: join(nwHome, 'reports'),
    NIGHTWATCH_AUDIT_PATH: join(nwHome, 'guard-audit.jsonl'),
    NIGHTWATCH_PORTS: '0',
    NIGHTWATCH_SSH: '0',
    NIGHTWATCH_BACKUP: '0',
    NIGHTWATCH_PROJECTION: projection ? '1' : '0',
  }
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [dshBin, '--profile', profile, 'Call watch_propose_fix with key tcp:4444 and then answer with its text.'], {
      env,
      cwd: root,
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    const timer = setTimeout(() => child.kill(), 120_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, output })
    })
  })
}

async function tryOnce(dshHome, nwHome, projection) {
  const captures = []
  const fake = await startFakeModel(captures)
  try {
    const runResult = await runAnalyst(dshHome, nwHome, fake.port, projection)
    const leaked = captures.some((body) => body.includes(CANARY))
    if (process.env.NW_EGRESS_DEBUG) {
      writeFileSync(
        process.env.NW_EGRESS_DEBUG,
        JSON.stringify(
          {
            kinds: globalThis.__nwKinds,
            output: runResult.output,
            requests: captures.map((body) => {
              const parsed = JSON.parse(body)
              return {
                system: String(parsed.system ?? '').slice(0, 120),
                messages: (parsed.messages ?? []).map((m) => ({
                  role: m.role,
                  text: JSON.stringify(m.content).slice(0, 2500),
                })),
              }
            }),
          },
          null,
          2,
        ),
        'utf8',
      )
    }
    return { leaked, requests: captures.length, code: runResult.code, output: runResult.output }
  } finally {
    await new Promise((resolvePromise) => fake.server.close(resolvePromise))
  }
}

async function main() {
  const dshHome = mkdtempSync(join(tmpdir(), 'nightwatch-egress-dsh-'))
  const nwHome = mkdtempSync(join(tmpdir(), 'nightwatch-egress-nw-'))
  try {
    makeProfile(dshHome)
    await seedCanary(nwHome)

    const withProjection = await tryOnce(dshHome, nwHome, true)
    const withoutProjection = await tryOnce(dshHome, nwHome, false)

    const report = {
      canary: CANARY,
      withProjection: { leaked: withProjection.leaked, requests: withProjection.requests },
      withoutProjection: { leaked: withoutProjection.leaked, requests: withoutProjection.requests },
      pass: !withProjection.leaked && withoutProjection.leaked,
    }
    console.log(`nightwatch-egress ${JSON.stringify(report)}`)
    if (!report.pass) {
      console.error(`--- analyst output (projection on, exit ${withProjection.code}) ---\n${withProjection.output.split('\n').slice(-12).join('\n')}`)
      process.exitCode = 1
    }
  } finally {
    for (const dir of [dshHome, nwHome]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch (error) {
        console.error(`cleanup skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

await main()
