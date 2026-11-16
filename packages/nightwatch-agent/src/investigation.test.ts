import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { investigateFinding, type AgentDecision, type Reasoner } from './investigation.js'
import { loadJudgments } from './judgment.js'
import { WatchStore } from './store.js'
import type { WatchConfig } from './tools.js'
import type { Finding, Observation } from './types.js'

const now = 1_800_000_000_000

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-investigation-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  const observation: Observation = {
    type: 'observation',
    id: 'obs-1',
    at: now,
    host: 'lab',
    collector: 'ssh',
    facts: [{ kind: 'ssh_option', key: 'ssh:passwordauthentication', value: 'yes' }],
    evidence: [{ command: 'sshd -T', exit: 0, outputSha256: '0'.repeat(64) }],
    status: 'ok',
  }
  const finding: Finding = {
    type: 'finding',
    id: 'find-1',
    at: now,
    kind: 'ssh_password_authentication',
    severity: 'high',
    key: 'ssh:passwordauthentication',
    title: 'SSH 允许密码登录',
    detail: '密码登录开着',
    epistemic: 'observed',
    observationId: 'obs-1',
    status: 'candidate',
    firstSeen: now,
    lastSeen: now,
  }
  store.append(observation)
  store.append(finding)
  const config: WatchConfig = {
    evidencePath: join(dir, 'watch.jsonl'),
    databasePath: join(dir, 'watch.db'),
    reportDir: join(dir, 'watch-reports'),
    ports: false,
    ssh: true,
    backup: false,
    backupPaths: [],
    backupStaleHours: 36,
  }
  return {
    dir,
    store,
    config,
    judgmentsPath: join(dir, 'judgments.jsonl'),
    cleanup: () => {
      store.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

const scripted: Reasoner = (() => {
  const steps: AgentDecision[] = [
    { action: 'read', tool: 'timeline', key: 'ssh:passwordauthentication', days: 7 },
    {
      action: 'conclude',
      judgment: {
        confirmed: [{ text: 'sshd -T 显示 PasswordAuthentication yes', evidenceRef: 'obs-1' }],
        candidates: [{ text: '运维可能临时开启', likelihood: 'medium' }],
        counter: ['没有新增公钥'],
        gaps: ['没有登录日志'],
        recommendation: '确认后关闭密码认证',
        disposition: 'propose',
        confidence: 'medium',
      },
    },
  ]
  let index = 0
  return { decide: async () => steps[Math.min(index++, steps.length - 1)]! }
})()

test('the loop reads, concludes, validates the evidence ref and writes one judgment', async () => {
  const { store, config, judgmentsPath, cleanup } = setup()
  try {
    const result = await investigateFinding(store, config, 'find-1', {
      reasoner: scripted,
      judgmentsPath,
      now,
      calls: 4,
      ms: 60_000,
      bytes: 65_536,
      model: 'stub-local',
    })
    assert.equal(result.status, 'concluded')
    assert.equal(result.reads.length, 1)
    assert.match(result.reads[0]!.text, /时间线/)
    const judgments = loadJudgments(judgmentsPath)
    assert.equal(judgments.length, 1)
    assert.equal(judgments[0]?.confirmed[0]?.evidenceRef, 'obs-1')
  } finally {
    cleanup()
  }
})

test('a fabricated evidence ref is rejected and nothing is written', async () => {
  const { store, config, judgmentsPath, cleanup } = setup()
  try {
    const liar: Reasoner = {
      decide: async () => ({
        action: 'conclude',
        judgment: {
          confirmed: [{ text: '编的', evidenceRef: 'obs-fabricated' }],
          candidates: [],
          counter: [],
          gaps: [],
          recommendation: 'x',
          disposition: 'propose',
          confidence: 'low',
        },
      }),
    }
    const result = await investigateFinding(store, config, 'find-1', {
      reasoner: liar,
      judgmentsPath,
      now,
      calls: 2,
      ms: 60_000,
      bytes: 65_536,
      model: 'stub-local',
    })
    assert.equal(result.status, 'invalid')
    assert.equal(loadJudgments(judgmentsPath).length, 0)
  } finally {
    cleanup()
  }
})

test('budget exhaustion stops the loop and returns no judgment', async () => {
  const { store, config, judgmentsPath, cleanup } = setup()
  try {
    const greedy: Reasoner = {
      decide: async () => ({ action: 'read', tool: 'timeline', key: 'ssh:passwordauthentication' }),
    }
    const result = await investigateFinding(store, config, 'find-1', {
      reasoner: greedy,
      judgmentsPath,
      now,
      calls: 2,
      ms: 60_000,
      bytes: 65_536,
      model: 'stub-local',
    })
    assert.equal(result.status, 'budget')
    assert.equal(result.reads.length, 2)
    assert.equal(loadJudgments(judgmentsPath).length, 0)
  } finally {
    cleanup()
  }
})
