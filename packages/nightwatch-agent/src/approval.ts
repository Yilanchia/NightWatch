import { createHash, generateKeyPairSync } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeIdFor, signPayload, verifyPayload, type NodeIdentity } from './identity.js'
import type { FixChange, FixProposal } from './types.js'

/**
 * Approval grants for the repair executor.
 *
 * The node identity is not the owner's approval key: this module keeps a separate key file
 * (`approval-key.json`) that only `nightwatch approve` touches. A grant binds:
 *   - one proposal (id + finding + kind),
 *   - the exact changes (digest),
 *   - the state of the file before the change (fingerprint),
 *   - an expiry and a one-time grant id.
 *
 * The executor verifies all of it and consumes the id before writing anything, so a replay or a
 * stale approval cannot be used.
 */

export interface ApprovalSubject {
  readonly proposalId: string
  readonly findingId: string
  readonly kind: string
  readonly changes: readonly FixChange[]
  readonly stateFingerprint: string
}

export interface ApprovalGrant {
  readonly type: 'approval'
  readonly id: string
  readonly at: number
  readonly expiresAt: number
  readonly approver: string
  readonly subject: ApprovalSubject
  readonly changeDigest: string
  readonly signature: string
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function changesDigest(changes: readonly FixChange[]): string {
  return sha256(JSON.stringify(changes.map((change) => ({ file: change.file, before: change.before, after: change.after }))))
}

export function stateFingerprint(content: string): string {
  return sha256(content)
}

function subjectPayload(subject: ApprovalSubject): string {
  return JSON.stringify({
    proposalId: subject.proposalId,
    findingId: subject.findingId,
    kind: subject.kind,
    changes: subject.changes.map((change) => ({ file: change.file, before: change.before, after: change.after })),
    stateFingerprint: subject.stateFingerprint,
  })
}

function grantPayload(grant: Omit<ApprovalGrant, 'signature'>): string {
  return JSON.stringify({
    type: grant.type,
    id: grant.id,
    at: grant.at,
    expiresAt: grant.expiresAt,
    approver: grant.approver,
    subject: JSON.parse(subjectPayload(grant.subject)) as unknown,
    changeDigest: grant.changeDigest,
  })
}

/** The owner's approval key, separate from the node identity. Created on first `approve`. */
export function ensureApprovalKey(home: string): NodeIdentity {
  const path = join(home, 'approval-key.json')
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as NodeIdentity
    if (stored.id === nodeIdFor(stored.publicKeyPem)) return stored
    throw new Error(`approval-key.json 的公钥与 ID 不一致：${path}`)
  }
  mkdirSync(home, { recursive: true })
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const identity: NodeIdentity = {
    id: nodeIdFor(publicKeyPem),
    publicKeyPem,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdAt: Date.now(),
  }
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows: mode is advisory.
  }
  return identity
}

export function loadApprovalKey(home: string): NodeIdentity | undefined {
  const path = join(home, 'approval-key.json')
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as NodeIdentity
}

export function createGrant(
  key: NodeIdentity,
  proposal: FixProposal,
  input: { stateFingerprint: string; approver: string; now: number; ttlMinutes?: number },
): ApprovalGrant {
  const subject: ApprovalSubject = {
    proposalId: proposal.id,
    findingId: proposal.findingId,
    kind: proposal.kind,
    changes: proposal.changes,
    stateFingerprint: input.stateFingerprint,
  }
  const changeDigest = changesDigest(proposal.changes)
  const base = {
    type: 'approval' as const,
    id: `grant-${input.now.toString(36)}-${changeDigest.slice(0, 8)}`,
    at: input.now,
    expiresAt: input.now + Math.max(1, input.ttlMinutes ?? 15) * 60_000,
    approver: input.approver,
    subject,
    changeDigest,
  }
  return { ...base, signature: signPayload(key, grantPayload(base)) }
}

export interface GrantCheck {
  readonly ok: boolean
  readonly reason?: string
}

export function verifyGrant(
  grant: ApprovalGrant,
  approvalPublicKeyPem: string,
  expected: { proposal: FixProposal; stateFingerprint: string; now: number },
): GrantCheck {
  if (grant.type !== 'approval') return { ok: false, reason: '不是审批凭证' }
  if (grant.expiresAt <= expected.now) return { ok: false, reason: '审批已过期' }
  if (grant.subject.proposalId !== expected.proposal.id) return { ok: false, reason: '审批对应的提案不一致' }
  if (grant.subject.findingId !== expected.proposal.findingId || grant.subject.kind !== expected.proposal.kind) {
    return { ok: false, reason: '审批绑定的发现或类型不一致' }
  }
  const digest = changesDigest(expected.proposal.changes)
  if (grant.changeDigest !== digest) return { ok: false, reason: '变更内容与审批时不一致' }
  if (grant.subject.stateFingerprint !== expected.stateFingerprint) {
    return { ok: false, reason: '文件当前状态与审批时不一致（可能已被改过）' }
  }
  if (!verifyPayload(approvalPublicKeyPem, grantPayload(grant), grant.signature)) {
    return { ok: false, reason: '审批签名无效' }
  }
  return { ok: true }
}

export function approvalsPath(home: string): string {
  return join(home, 'approvals.jsonl')
}

function consumedPath(home: string): string {
  return join(home, 'approvals-consumed.jsonl')
}

export function appendGrant(home: string, grant: ApprovalGrant): void {
  mkdirSync(home, { recursive: true })
  appendFileSync(approvalsPath(home), `${JSON.stringify(grant)}\n`, 'utf8')
}

export function findGrant(home: string, id: string): ApprovalGrant | undefined {
  const path = approvalsPath(home)
  if (!existsSync(path)) return undefined
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const grant = JSON.parse(line) as ApprovalGrant
      if (grant.id === id) return grant
    } catch {
      // Skip malformed lines; grants are append-only history.
    }
  }
  return undefined
}

export function isConsumed(home: string, id: string): boolean {
  const path = consumedPath(home)
  if (!existsSync(path)) return false
  return readFileSync(path, 'utf8')
    .split('\n')
    .some((line) => {
      try {
        return line.trim() !== '' && (JSON.parse(line) as { id?: string }).id === id
      } catch {
        return false
      }
    })
}

/** Consume once. Returns false when the grant was already used. */
export function consumeGrant(home: string, id: string, now: number): boolean {
  if (isConsumed(home, id)) return false
  appendFileSync(consumedPath(home), `${JSON.stringify({ type: 'consumed', id, at: now })}\n`, 'utf8')
  return true
}
