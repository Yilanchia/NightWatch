import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  consumeGrant,
  createGrant,
  ensureApprovalKey,
  findGrant,
  stateFingerprint,
  verifyGrant,
  appendGrant,
} from './approval.js'
import { applyFix } from './tools.js'
import { WatchStore } from './store.js'
import type { FixProposal } from './types.js'
import type { WatchConfig } from './tools.js'

const at = 1_800_000_000_000

function proposal(): FixProposal {
  return {
    type: 'proposal',
    id: 'fix-1',
    at,
    findingId: 'find-1',
    key: 'ssh:passwordauthentication',
    kind: 'ssh_password_authentication',
    title: 'SSH 允许密码登录',
    changes: [{ file: 'sshd_config', before: 'PasswordAuthentication yes', after: 'PasswordAuthentication no' }],
    risk: 'medium',
    rollback: 'cp backup back',
    verify: 'sshd -t',
    executable: true,
  }
}

test('a grant binds proposal, changes, state, expiry and a one-time id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-approval-'))
  try {
    const key = ensureApprovalKey(dir)
    const plan = proposal()
    const fingerprint = stateFingerprint('PasswordAuthentication yes\n')
    const grant = createGrant(key, plan, { stateFingerprint: fingerprint, approver: 'owner', now: at, ttlMinutes: 15 })

    assert.deepEqual(verifyGrant(grant, key.publicKeyPem, { proposal: plan, stateFingerprint: fingerprint, now: at }).ok, true)
    // Expiry.
    assert.match(
      verifyGrant(grant, key.publicKeyPem, { proposal: plan, stateFingerprint: fingerprint, now: at + 16 * 60_000 }).reason ?? '',
      /过期/,
    )
    // File changed after approval.
    assert.match(
      verifyGrant(grant, key.publicKeyPem, { proposal: plan, stateFingerprint: stateFingerprint('changed'), now: at }).reason ?? '',
      /状态/,
    )
    // Proposal changed after approval.
    const changed = { ...plan, changes: [{ ...plan.changes[0]!, after: 'PasswordAuthentication no # tampered' }] }
    assert.match(
      verifyGrant(grant, key.publicKeyPem, { proposal: changed, stateFingerprint: fingerprint, now: at }).reason ?? '',
      /变更内容/,
    )
    // Signature.
    assert.match(
      verifyGrant({ ...grant, signature: 'AAAA' }, key.publicKeyPem, { proposal: plan, stateFingerprint: fingerprint, now: at }).reason ?? '',
      /签名/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('a grant can be consumed exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-approval-use-'))
  try {
    const key = ensureApprovalKey(dir)
    const grant = createGrant(key, proposal(), {
      stateFingerprint: stateFingerprint('x'),
      approver: 'owner',
      now: at,
    })
    appendGrant(dir, grant)
    assert.equal(findGrant(dir, grant.id)?.id, grant.id)
    assert.equal(consumeGrant(dir, grant.id, at), true)
    assert.equal(consumeGrant(dir, grant.id, at + 1), false)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('the executor refuses without an approval and applies with one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-approval-apply-'))
  try {
    const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
    const file = join(dir, 'sshd_config')
    writeFileSync(file, 'PasswordAuthentication yes\n', 'utf8')
    const plan = proposal()
    store.append(plan)
    const config: WatchConfig = {
      evidencePath: join(dir, 'watch.jsonl'),
      databasePath: join(dir, 'watch.db'),
      reportDir: join(dir, 'reports'),
      ports: false,
      ssh: false,
      backup: false,
      backupPaths: [],
      backupStaleHours: 36,
      sshdConfig: file,
    }
    const ctx = { store, config, platform: 'linux' as const, now: () => at }

    assert.match(applyFix(ctx, plan.id), /需要主人审批/)
    const key = ensureApprovalKey(dir)
    const grant = createGrant(key, plan, {
      stateFingerprint: stateFingerprint(readFileSync(file, 'utf8')),
      approver: 'owner',
      now: at,
    })
    appendGrant(dir, grant)
    assert.match(applyFix(ctx, plan.id, grant.id), /已应用/)
    assert.match(readFileSync(file, 'utf8'), /PasswordAuthentication no/)

    // A used grant cannot be replayed.
    assert.match(applyFix(ctx, plan.id, grant.id), /无效|使用过/)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
