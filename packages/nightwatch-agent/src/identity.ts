import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A node's identity. The private key never leaves the machine; the id is a fingerprint of the
 * public key, so another node can check "this bundle really came from that node" without a CA.
 *
 * This is the first piece of the multi-node vision: evidence stays local, exported summaries are
 * signed, and the coordinator can verify origin before trusting a finding.
 */

export interface NodeIdentity {
  readonly id: string
  readonly publicKeyPem: string
  readonly privateKeyPem: string
  readonly createdAt: number
}

export function nodeIdFor(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  return `nw-${createHash('sha256').update(der).digest('base64url').slice(0, 12)}`
}

/** Load the identity, creating it on first use (0600 on POSIX; Windows ACLs are the owner's). */
export function ensureIdentity(home: string): NodeIdentity {
  const path = join(home, 'identity.json')
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as NodeIdentity
    if (stored.id === nodeIdFor(stored.publicKeyPem)) return stored
    throw new Error(`identity.json 的公钥与节点 ID 不一致：${path}`)
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
    // Windows: mode is advisory; skip silently.
  }
  return identity
}

export function signPayload(identity: NodeIdentity, payload: string): string {
  return sign(null, Buffer.from(payload, 'utf8'), createPrivateKey(identity.privateKeyPem)).toString('base64')
}

export function verifyPayload(publicKeyPem: string, payload: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(payload, 'utf8'), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}
