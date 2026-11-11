import type { WatchStore } from './store.js'
import type { ObservationStatus } from './types.js'
import type { WatchConfig } from './tools.js'
import { inspectionHealth } from './inspect.js'
import { nodeIdFor, signPayload, verifyPayload, type NodeIdentity } from './identity.js'

/**
 * The cross-node unit: a signed summary of what this node saw, with no raw facts or evidence.
 * It is enough for a coordinator to correlate findings across machines and to check the sender,
 * and it deliberately cannot be used to reconstruct the machine.
 */

export interface BundleRun {
  readonly id: string
  readonly at: number
  readonly trigger: string
  readonly health: ObservationStatus
  readonly blindSpots: readonly string[]
}

export interface BundleFinding {
  readonly key: string
  readonly kind: string
  readonly severity: string
  readonly status: string
  readonly title: string
  readonly firstSeen?: number
  readonly lastSeen?: number
  readonly resolvedAt?: number
}

export interface BundleHealth {
  readonly collectors: ReadonlyArray<{ name: string; lastStatus?: ObservationStatus; lastOkAt?: number }>
  readonly blindSpots: readonly string[]
  readonly stale: readonly string[]
  readonly skipped: readonly string[]
}

export interface BundlePayload {
  readonly version: 1
  readonly node: { readonly id: string; readonly publicKeyPem: string }
  readonly generatedAt: number
  readonly window: { readonly from: number; readonly to: number }
  readonly runs: readonly BundleRun[]
  readonly findings: readonly BundleFinding[]
  readonly health: BundleHealth
}

export interface NodeBundle {
  readonly payload: BundlePayload
  readonly signature: string
}

/** Stable JSON: sorted keys, so signing and verification cannot drift on property order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

export interface BundleOptions {
  readonly now: number
  /** Window for runs and resolved findings; defaults to 7 days. */
  readonly days?: number
}

export function buildBundle(store: WatchStore, config: WatchConfig, identity: NodeIdentity, options: BundleOptions): NodeBundle {
  const span = Math.max(1, options.days ?? 7) * 86_400_000
  const from = options.now - span

  const runs: BundleRun[] = store.runsSince(from, options.now).map((run) => ({
    id: run.id,
    at: run.at,
    trigger: run.trigger,
    health: run.health,
    blindSpots: run.blindSpots,
  }))

  const seen = new Set<string>()
  const findings: BundleFinding[] = []
  const consider = (source: readonly {
    id: string
    key: string
    kind: string
    severity: string
    status: string
    title: string
    firstSeen?: number
    lastSeen?: number
    resolvedAt?: number
  }[]): void => {
    for (const item of source) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      findings.push({
        key: item.key,
        kind: item.kind,
        severity: item.severity,
        status: item.status,
        title: item.title,
        ...(item.firstSeen !== undefined ? { firstSeen: item.firstSeen } : {}),
        ...(item.lastSeen !== undefined ? { lastSeen: item.lastSeen } : {}),
        ...(item.resolvedAt !== undefined ? { resolvedAt: item.resolvedAt } : {}),
      })
    }
  }
  consider(store.openFindings())
  consider(store.findings("status IN ('fixed', 'invalid') AND resolved_at >= ? AND resolved_at <= ?", from, options.now))

  const health = inspectionHealth(store, config, options.now)
  const payload: BundlePayload = {
    version: 1,
    node: { id: identity.id, publicKeyPem: identity.publicKeyPem },
    generatedAt: options.now,
    window: { from, to: options.now },
    runs,
    findings,
    health: {
      collectors: health.collectors.map((collector) => ({
        name: collector.name,
        ...(collector.lastStatus ? { lastStatus: collector.lastStatus } : {}),
        ...(collector.lastOkAt !== undefined ? { lastOkAt: collector.lastOkAt } : {}),
      })),
      blindSpots: health.blindSpots,
      stale: health.stale,
      skipped: health.skipped,
    },
  }
  return { payload, signature: signPayload(identity, canonicalJson(payload)) }
}

export interface VerifyResult {
  readonly ok: boolean
  readonly reason?: string
}

/** Check the signature and that the id matches the embedded public key. */
export function verifyBundle(bundle: NodeBundle): VerifyResult {
  const payload = bundle.payload
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'payload 缺失' }
  if (payload.version !== 1) return { ok: false, reason: `不认识的版本 ${String(payload.version)}` }
  const expected = nodeIdFor(payload.node.publicKeyPem)
  if (expected !== payload.node.id) return { ok: false, reason: '节点 ID 与公钥指纹不一致' }
  if (!verifyPayload(payload.node.publicKeyPem, canonicalJson(payload), bundle.signature)) {
    return { ok: false, reason: '签名校验失败' }
  }
  return { ok: true }
}
