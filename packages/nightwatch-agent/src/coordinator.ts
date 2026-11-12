import { verifyBundle, type BundleCapabilities, type BundleFinding, type NodeBundle } from './export.js'

/**
 * A small coordinator prototype: only registered nodes may send bundles; each bundle is verified,
 * deduped by (node id, finding id), and open findings are grouped by fact key across nodes.
 *
 * Registration is an explicit owner action (`register`); ingesting from a node the owner has not
 * registered is refused, so a fresh node cannot silently insert itself into the picture.
 */

export interface CoordinatorNode {
  readonly publicKeyPem: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly registeredAt: number
  /** Highest bundle seq seen; lower seq means a stale delivery. */
  readonly lastSeq: number
  readonly capabilities: BundleCapabilities
  readonly lastRunAt?: number
  readonly lastHealth?: string
}

export interface CoordinatorFinding extends BundleFinding {
  readonly nodeId: string
  readonly ingestedAt: number
}

export interface CoordinatorState {
  readonly version: 1
  readonly nodes: Record<string, CoordinatorNode>
  readonly findings: Record<string, CoordinatorFinding>
  readonly updatedAt: number
}

export function emptyState(now: number): CoordinatorState {
  return { version: 1, nodes: {}, findings: {}, updatedAt: now }
}

export interface RegisterResult {
  readonly ok: boolean
  readonly reason?: string
  readonly state: CoordinatorState
  readonly nodeId: string
  readonly alreadyRegistered: boolean
}

/** Explicit owner action: accept this node's public key before any finding from it is trusted. */
export function registerNode(state: CoordinatorState, bundle: NodeBundle, now: number): RegisterResult {
  const verdict = verifyBundle(bundle)
  if (!verdict.ok) return { ok: false, reason: verdict.reason ?? '校验失败', state, nodeId: '', alreadyRegistered: false }

  const payload = bundle.payload
  const nodeId = payload.node.id
  const existing = state.nodes[nodeId]
  if (existing) {
    if (existing.publicKeyPem !== payload.node.publicKeyPem) {
      return { ok: false, reason: `节点 ${nodeId} 的公钥与已登记的不一致`, state, nodeId, alreadyRegistered: true }
    }
    return { ok: true, state, nodeId, alreadyRegistered: true }
  }

  return {
    ok: true,
    state: {
      ...state,
      nodes: {
        ...state.nodes,
        [nodeId]: {
          publicKeyPem: payload.node.publicKeyPem,
          firstSeen: now,
          lastSeen: now,
          registeredAt: now,
          lastSeq: 0,
          capabilities: payload.capabilities,
        },
      },
      updatedAt: now,
    },
    nodeId,
    alreadyRegistered: false,
  }
}

export interface IngestResult {
  readonly ok: boolean
  readonly reason?: string
  readonly state: CoordinatorState
  readonly nodeId: string
  readonly added: number
  readonly updated: number
  readonly staleSeq: boolean
}

/** Upsert findings by (node, finding id) for a registered node. Replays are idempotent. */
export function ingestBundle(state: CoordinatorState, bundle: NodeBundle, now: number): IngestResult {
  const verdict = verifyBundle(bundle)
  if (!verdict.ok) return { ok: false, reason: verdict.reason ?? '校验失败', state, nodeId: '', added: 0, updated: 0, staleSeq: false }

  const payload = bundle.payload
  const nodeId = payload.node.id
  const existing = state.nodes[nodeId]
  if (!existing) {
    return { ok: false, reason: `节点 ${nodeId} 未登记，先用 register 接受它的公钥`, state, nodeId, added: 0, updated: 0, staleSeq: false }
  }
  if (existing.publicKeyPem !== payload.node.publicKeyPem) {
    return { ok: false, reason: `节点 ${nodeId} 的公钥与已登记的不一致`, state, nodeId, added: 0, updated: 0, staleSeq: false }
  }

  const latestRun = payload.runs.reduce<number | undefined>(
    (latest, run) => (latest === undefined || run.at > latest ? run.at : latest),
    undefined,
  )
  const lastHealth = payload.runs.length > 0 ? payload.runs[payload.runs.length - 1]!.health : existing.lastHealth
  const staleSeq = payload.seq < existing.lastSeq

  const nodes: Record<string, CoordinatorNode> = {
    ...state.nodes,
    [nodeId]: {
      ...existing,
      lastSeen: now,
      lastSeq: Math.max(existing.lastSeq, payload.seq),
      capabilities: existing.capabilities,
      ...(latestRun !== undefined ? { lastRunAt: Math.max(existing.lastRunAt ?? 0, latestRun) } : {}),
      ...(lastHealth ? { lastHealth } : {}),
    },
  }

  const findings: Record<string, CoordinatorFinding> = { ...state.findings }
  let added = 0
  let updated = 0
  for (const finding of payload.findings) {
    const key = `${nodeId}:${finding.id}`
    const previous = findings[key]
    if (!previous) {
      findings[key] = { ...finding, nodeId, ingestedAt: now }
      added += 1
      continue
    }
    const previousAt = previous.lastSeen ?? previous.resolvedAt ?? 0
    const currentAt = finding.lastSeen ?? finding.resolvedAt ?? 0
    if (currentAt >= previousAt) {
      findings[key] = { ...finding, nodeId, ingestedAt: previous.ingestedAt }
      updated += 1
    }
  }

  return { ok: true, state: { version: 1, nodes, findings, updatedAt: now }, nodeId, added, updated, staleSeq }
}

export interface CorrelatedGroup {
  readonly key: string
  readonly kind: string
  readonly nodes: readonly string[]
  readonly findings: readonly CoordinatorFinding[]
  readonly crossNode: boolean
}

/** Open findings grouped by fact key; `crossNode` means more than one node reports it. */
export function correlate(state: CoordinatorState): CorrelatedGroup[] {
  const groups = new Map<string, { key: string; kind: string; nodes: string[]; findings: CoordinatorFinding[] }>()
  for (const finding of Object.values(state.findings)) {
    if (finding.status !== 'candidate' && finding.status !== 'verified') continue
    const group = groups.get(finding.key) ?? { key: finding.key, kind: finding.kind, nodes: [], findings: [] }
    if (!group.nodes.includes(finding.nodeId)) group.nodes.push(finding.nodeId)
    group.findings.push(finding)
    groups.set(finding.key, group)
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      kind: group.kind,
      nodes: [...group.nodes].sort(),
      findings: group.findings,
      crossNode: group.nodes.length > 1,
    }))
    .sort((left, right) => Number(right.crossNode) - Number(left.crossNode) || left.key.localeCompare(right.key))
}
