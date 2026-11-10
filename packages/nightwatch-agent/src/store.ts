import { DatabaseSync } from 'node:sqlite'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { statusOf } from './health.js'
import type { Baseline, Fact, Finding, FixChange, FixProposal, Observation, ObservationStatus, RunEvent, TimelinePoint, WatchEvent } from './types.js'

/**
 * The evidence log and its view.
 *
 * `watch.jsonl` is the truth: append-only, one event per line, never edited. The SQLite file is
 * a materialized view rebuilt from it on open — delete it and the next start recreates it. That
 * is the same rule as her life log: the log is the truth, the index is a view.
 */

/** What a torn-tail repair moved aside, so the report can say the log was repaired. */
export interface Recovery {
  readonly tornPath: string
  readonly tornBytes: number
  readonly at: number
}

const SCHEMA = `
DROP TABLE IF EXISTS observations;
DROP TABLE IF EXISTS findings;
DROP TABLE IF EXISTS finding_updates;
DROP TABLE IF EXISTS baselines;
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS proposals;
DROP TABLE IF EXISTS actions;
DROP TABLE IF EXISTS runs;
CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  host TEXT NOT NULL,
  collector TEXT NOT NULL,
  facts TEXT NOT NULL,
  evidence TEXT NOT NULL,
  status TEXT,
  error TEXT
);
CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  epistemic TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_checked INTEGER,
  resolved_at INTEGER,
  recurrence_of TEXT
);
CREATE TABLE finding_updates (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  finding_id TEXT NOT NULL,
  status TEXT,
  last_seen INTEGER,
  last_checked INTEGER,
  resolved_at INTEGER
);
CREATE INDEX finding_updates_by_finding ON finding_updates (finding_id, at);
CREATE TABLE IF NOT EXISTS baselines (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  host TEXT NOT NULL,
  facts TEXT NOT NULL,
  observation_ids TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  finding_id TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  changes TEXT NOT NULL,
  risk TEXT NOT NULL,
  rollback TEXT NOT NULL,
  verify TEXT NOT NULL,
  executable INTEGER NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS proposals_by_finding ON proposals (finding_id);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  proposal_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  changes TEXT NOT NULL,
  backup_paths TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS actions_by_proposal ON actions (proposal_id);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  health TEXT NOT NULL,
  blind_spots TEXT NOT NULL,
  notes TEXT NOT NULL,
  report_path TEXT
);
CREATE INDEX IF NOT EXISTS runs_by_at ON runs (at);
CREATE INDEX IF NOT EXISTS runs_by_health ON runs (health, at);
CREATE INDEX IF NOT EXISTS findings_by_key ON findings (key);
CREATE INDEX IF NOT EXISTS findings_by_status ON findings (status);
CREATE INDEX IF NOT EXISTS observations_by_collector ON observations (collector, at);
`

export interface StoreOptions {
  /**
   * Open without the writer lock and without rebuilding. Used by `health` / `timeline` while the
   * daemon holds the lock: readers see the daemon's live SQLite view and never touch the log.
   */
  readonly readOnly?: boolean
}

export class WatchStore {
  private db!: DatabaseSync
  private readonly lockPath: string
  private readonly readOnly: boolean
  private lockFd: number | undefined
  private locked = false
  private readonly ids = new Set<string>()
  /** Set when opening found a half-written tail; kept so callers can say so instead of hiding it. */
  readonly recovery: Recovery | undefined = undefined

  constructor(
    private readonly jsonlPath: string,
    private readonly dbPath: string,
    options: StoreOptions = {},
  ) {
    mkdirSync(dirname(jsonlPath), { recursive: true })
    mkdirSync(dirname(dbPath), { recursive: true })
    this.readOnly = options.readOnly === true
    this.lockPath = `${jsonlPath}.lock`
    if (this.readOnly) {
      // The daemon owns the log. Reading its view must not take the writer lock or replay the log.
      this.db = new DatabaseSync(dbPath, { readOnly: true })
      return
    }
    this.acquireLock()
    let db: DatabaseSync | undefined
    try {
      this.recovery = this.recoverTail()
      db = new DatabaseSync(dbPath)
      this.db = db
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec(SCHEMA)
      this.rebuild()
    } catch (error) {
      db?.close()
      this.releaseLock()
      throw error
    }
  }

  /**
   * One writer per evidence log. A second process would interleave appends and corrupt the tail
   * protocol, so it is refused rather than trusted to be careful.
   */
  private acquireLock(): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.lockFd = openSync(this.lockPath, 'wx')
        writeSync(this.lockFd, String(process.pid))
        this.locked = true
        return
      } catch (error) {
        if (!existsSync(this.lockPath)) throw error
        const owner = Number.parseInt(readFileSync(this.lockPath, 'utf8').trim(), 10)
        if (Number.isInteger(owner) && this.isAlive(owner)) {
          throw new Error(`另一个 Nightwatch 进程（pid ${owner}）正在写 ${this.jsonlPath}；先停掉它。`)
        }
        unlinkSync(this.lockPath)
      }
    }
    throw new Error(`无法取得 ${this.lockPath} 的写锁。`)
  }

  private isAlive(pid: number): boolean {
    if (pid === process.pid) return true
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  private releaseLock(): void {
    if (this.lockFd !== undefined) {
      closeSync(this.lockFd)
      this.lockFd = undefined
    }
    // A read-only store never owned the lock; deleting it would break the running daemon.
    if (this.locked && existsSync(this.lockPath)) unlinkSync(this.lockPath)
    this.locked = false
  }

  /**
   * A crash can leave half a line at the end. It is moved aside (visible, not deleted) and the
   * log ends on the last complete line, so the next append cannot glue itself to the fragment.
   * A complete JSON line without its trailing newline is kept, not quarantined.
   */
  private recoverTail(): Recovery | undefined {
    if (!existsSync(this.jsonlPath)) return undefined
    const bytes = readFileSync(this.jsonlPath)
    if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return undefined
    const lastNewline = bytes.lastIndexOf(0x0a)
    const torn = bytes.subarray(lastNewline + 1)
    let parsed: unknown
    try {
      parsed = JSON.parse(torn.toString('utf8'))
    } catch {
      parsed = undefined
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
      // The event is complete; only the newline was lost. Keep it.
      appendFileSync(this.jsonlPath, '\n', 'utf8')
      return undefined
    }
    const good = lastNewline === -1 ? Buffer.alloc(0) : bytes.subarray(0, lastNewline + 1)
    const tornPath = `${this.jsonlPath}.torn-${Date.now().toString(36)}-${process.pid}`
    writeFileSync(tornPath, torn)
    writeFileSync(this.jsonlPath, good)
    return { tornPath, tornBytes: torn.length, at: Date.now() }
  }

  /** Reads the log. Corruption that is not a torn tail is an error, not something to skip. */
  events(): WatchEvent[] {
    if (!existsSync(this.jsonlPath)) return []
    const lines = readFileSync(this.jsonlPath, 'utf8').split('\n')
    const events: WatchEvent[] = []
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as WatchEvent)
      } catch {
        throw new Error(`watch.jsonl 第 ${index + 1} 行损坏（不是尾部半行）；拒绝猜测或静默跳过。`)
      }
    }
    return events
  }

  append(event: WatchEvent): void {
    if (this.readOnly) throw new Error('read-only store: cannot append to the evidence log')
    if (this.ids.has(event.id)) throw new Error(`事件 ID 重复：${event.id}（${event.type}）；日志已损坏，拒绝覆盖。`)
    this.ids.add(event.id)
    appendFileSync(this.jsonlPath, `${JSON.stringify(event)}\n`, 'utf8')
    this.insert(event)
  }

  /** Drops the view and replays the log. Always called on open, so the view can never drift. */
  rebuild(): void {
    if (this.readOnly) throw new Error('read-only store: cannot rebuild the view')
    this.db.exec(
      'DELETE FROM observations; DELETE FROM findings; DELETE FROM finding_updates; DELETE FROM baselines; DELETE FROM reports; DELETE FROM proposals; DELETE FROM actions; DELETE FROM runs;',
    )
    this.ids.clear()
    for (const event of this.events()) {
      if (this.ids.has(event.id)) {
        throw new Error(`watch.jsonl 有重复的事件 ID ${event.id}（${event.type}）；日志已损坏，拒绝静默去重。`)
      }
      this.ids.add(event.id)
      this.insert(event)
    }
  }

  private insert(event: WatchEvent): void {
    switch (event.type) {
      case 'observation':
        this.db
          .prepare('INSERT OR REPLACE INTO observations (id, at, host, collector, facts, evidence, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(
            event.id,
            event.at,
            event.host,
            event.collector,
            JSON.stringify(event.facts),
            JSON.stringify(event.evidence),
            event.status ?? statusOf(event.evidence),
            event.error ?? null,
          )
        return
      case 'finding':
        this.db
          .prepare(
            'INSERT OR REPLACE INTO findings (id, at, kind, severity, key, title, detail, epistemic, observation_id, status, first_seen, last_seen, last_checked, resolved_at, recurrence_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            event.id,
            event.at,
            event.kind,
            event.severity,
            event.key,
            event.title,
            event.detail,
            event.epistemic,
            event.observationId,
            event.status,
            event.firstSeen ?? event.at,
            event.lastSeen ?? event.at,
            event.lastChecked ?? null,
            event.resolvedAt ?? null,
            event.recurrenceOf ?? null,
          )
        return
      case 'finding-update':
        this.db
          .prepare('INSERT OR REPLACE INTO finding_updates (id, at, finding_id, status, last_seen, last_checked, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(
            event.id,
            event.at,
            event.findingId,
            event.status ?? null,
            event.lastSeen ?? null,
            event.lastChecked ?? null,
            event.resolvedAt ?? null,
          )
        this.db
          .prepare(
            'UPDATE findings SET status = COALESCE(?, status), last_seen = COALESCE(?, last_seen), last_checked = COALESCE(?, last_checked), resolved_at = COALESCE(?, resolved_at) WHERE id = ?',
          )
          .run(event.status ?? null, event.lastSeen ?? null, event.lastChecked ?? null, event.resolvedAt ?? null, event.findingId)
        return
      case 'run':
        this.db
          .prepare('INSERT OR REPLACE INTO runs (id, at, trigger, health, blind_spots, notes, report_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(event.id, event.at, event.trigger, event.health, JSON.stringify(event.blindSpots), JSON.stringify(event.notes), event.reportPath ?? null)
        return
      case 'baseline':
        this.db
          .prepare('INSERT OR REPLACE INTO baselines (id, at, host, facts, observation_ids) VALUES (?, ?, ?, ?, ?)')
          .run(event.id, event.at, event.host, JSON.stringify(event.facts), JSON.stringify(event.observationIds))
        return
      case 'report':
        this.db.prepare('INSERT OR REPLACE INTO reports (id, at, path) VALUES (?, ?, ?)').run(event.id, event.at, event.path)
        return
      case 'proposal':
        this.db
          .prepare(
            'INSERT OR REPLACE INTO proposals (id, at, finding_id, key, kind, title, changes, risk, rollback, verify, executable, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            event.id,
            event.at,
            event.findingId,
            event.key,
            event.kind,
            event.title,
            JSON.stringify(event.changes),
            event.risk,
            event.rollback,
            event.verify,
            event.executable ? 1 : 0,
            event.reason ?? null,
          )
        return
      case 'action':
        this.db
          .prepare(
            'INSERT OR REPLACE INTO actions (id, at, proposal_id, finding_id, kind, changes, backup_paths, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            event.id,
            event.at,
            event.proposalId,
            event.findingId,
            event.kind,
            JSON.stringify(event.changes),
            JSON.stringify(event.backupPaths),
            event.outcome,
            event.detail,
          )
        return
    }
  }

  /** The most recent baseline, if the owner ever took one. */
  latestBaseline(): Baseline | undefined {
    return this.baselineBefore(Number.POSITIVE_INFINITY)
  }

  /** The baseline that was in force just before `at`, for a historical report. */
  baselineBefore(at: number): Baseline | undefined {
    const row = this.db
      .prepare('SELECT id, at, host, facts, observation_ids FROM baselines WHERE at < ? ORDER BY at DESC LIMIT 1')
      .get(at) as { id: string; at: number; host: string; facts: string; observation_ids: string } | undefined
    if (!row) return undefined
    return {
      type: 'baseline',
      id: row.id,
      at: row.at,
      host: row.host,
      facts: JSON.parse(row.facts) as Fact[],
      observationIds: JSON.parse(row.observation_ids) as string[],
    }
  }

  /** The latest observation per collector, so a diff compares like with like. */
  latestObservations(): Map<string, Observation> {
    return this.observationsBefore(Number.POSITIVE_INFINITY)
  }

  /** The latest observation per collector before `at`, so a past day is not filled with today. */
  observationsBefore(at: number): Map<string, Observation> {
    const rows = this.db
      .prepare(
        `SELECT o.* FROM observations o
         JOIN (SELECT collector, MAX(at) AS at FROM observations WHERE at < ? GROUP BY collector) latest
           ON o.collector = latest.collector AND o.at = latest.at`,
      )
      .all(at) as Array<{
      id: string
      at: number
      host: string
      collector: string
      facts: string
      evidence: string
      status: string | null
      error: string | null
    }>
    const observations = new Map<string, Observation>()
    for (const row of rows) {
      observations.set(row.collector, {
        type: 'observation',
        id: row.id,
        at: row.at,
        host: row.host,
        collector: row.collector,
        facts: JSON.parse(row.facts) as Fact[],
        evidence: JSON.parse(row.evidence) as Observation['evidence'],
        ...(row.status ? { status: row.status as ObservationStatus } : {}),
        ...(row.error ? { error: row.error } : {}),
      })
    }
    return observations
  }

  /** Last time this collector read successfully, for the "data is getting old" note. */
  lastOkAt(collector: string): number | undefined {
    const row = this.db
      .prepare("SELECT MAX(at) AS at FROM observations WHERE collector = ? AND status = 'ok'")
      .get(collector) as { at: number | null } | undefined
    return row?.at ?? undefined
  }

  /** Findings that still stand (candidate or verified), newest first. */
  openFindings(): Finding[] {
    return this.findings("status IN ('candidate', 'verified')")
  }

  findings(where = '1 = 1', ...params: Array<string | number>): Finding[] {
    const rows = this.db
      .prepare(
        `SELECT id, at, kind, severity, key, title, detail, epistemic, observation_id, status,
                first_seen, last_seen, last_checked, resolved_at, recurrence_of
         FROM findings WHERE ${where} ORDER BY at DESC`,
      )
      .all(...params) as Array<{
      id: string
      at: number
      kind: string
      severity: string
      key: string
      title: string
      detail: string
      epistemic: string
      observation_id: string
      status: string
      first_seen: number
      last_seen: number
      last_checked: number | null
      resolved_at: number | null
      recurrence_of: string | null
    }>
    return rows.map((row) => ({
      type: 'finding',
      id: row.id,
      at: row.at,
      kind: row.kind,
      severity: row.severity as Finding['severity'],
      key: row.key,
      title: row.title,
      detail: row.detail,
      epistemic: row.epistemic as Finding['epistemic'],
      observationId: row.observation_id,
      status: row.status as Finding['status'],
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      ...(row.last_checked !== null ? { lastChecked: row.last_checked } : {}),
      ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
      ...(row.recurrence_of !== null ? { recurrenceOf: row.recurrence_of } : {}),
    }))
  }

  /** Keys of findings that still stand, so a repeat run does not restate the same thing. */
  openFindingKeys(): Set<string> {
    const rows = this.db.prepare("SELECT key FROM findings WHERE status IN ('candidate', 'verified')").all() as Array<{ key: string }>
    return new Set(rows.map((row) => row.key))
  }

  /** The newest repair plan for one finding, if one was ever written. */
  proposalFor(findingId: string): FixProposal | undefined {
    const row = this.db
      .prepare('SELECT id, at, finding_id, key, kind, title, changes, risk, rollback, verify, executable, reason FROM proposals WHERE finding_id = ? ORDER BY at DESC LIMIT 1')
      .get(findingId) as
      | {
          id: string
          at: number
          finding_id: string
          key: string
          kind: string
          title: string
          changes: string
          risk: string
          rollback: string
          verify: string
          executable: number
          reason: string | null
        }
      | undefined
    if (!row) return undefined
    return this.toProposal(row)
  }

  /** One plan by its own id, for applying it. */
  proposalById(id: string): FixProposal | undefined {
    const row = this.db
      .prepare('SELECT id, at, finding_id, key, kind, title, changes, risk, rollback, verify, executable, reason FROM proposals WHERE id = ? LIMIT 1')
      .get(id) as
      | {
          id: string
          at: number
          finding_id: string
          key: string
          kind: string
          title: string
          changes: string
          risk: string
          rollback: string
          verify: string
          executable: number
          reason: string | null
        }
      | undefined
    return row ? this.toProposal(row) : undefined
  }

  private toProposal(row: {
    id: string
    at: number
    finding_id: string
    key: string
    kind: string
    title: string
    changes: string
    risk: string
    rollback: string
    verify: string
    executable: number
    reason: string | null
  }): FixProposal {
    return {
      type: 'proposal',
      id: row.id,
      at: row.at,
      findingId: row.finding_id,
      key: row.key,
      kind: row.kind,
      title: row.title,
      changes: JSON.parse(row.changes) as FixChange[],
      risk: row.risk as FixProposal['risk'],
      rollback: row.rollback,
      verify: row.verify,
      executable: row.executable === 1,
      ...(row.reason ? { reason: row.reason } : {}),
    }
  }

  /**
   * What happened to one fact between two instants: reads, the finding, confirmations, resolution.
   * A missing read is a gap the caller can see by its absence, not a "no change" claim.
   */
  timeline(key: string, from: number, to: number): TimelinePoint[] {
    const points: TimelinePoint[] = []
    const observations = this.db
      .prepare('SELECT at, collector, facts, status FROM observations WHERE at >= ? AND at <= ? ORDER BY at')
      .all(from, to) as Array<{ at: number; collector: string; facts: string; status: string | null }>
    for (const row of observations) {
      const fact = (JSON.parse(row.facts) as Fact[]).find((candidate) => candidate.key === key)
      if (!fact) continue
      points.push({
        at: row.at,
        kind: 'observed',
        collector: row.collector,
        ...(row.status ? { status: row.status as ObservationStatus } : {}),
        detail: fact.value,
      })
    }

    const findings = this.db
      .prepare('SELECT id, at, title, status FROM findings WHERE key = ? AND at >= ? AND at <= ?')
      .all(key, from, to) as Array<{ id: string; at: number; title: string; status: string }>
    for (const row of findings) {
      points.push({ at: row.at, kind: 'finding', detail: `${row.title}（${row.status}）` })
    }

    const updates = this.db
      .prepare(
        `SELECT u.at, u.status, f.title FROM finding_updates u JOIN findings f ON f.id = u.finding_id
         WHERE f.key = ? AND u.at >= ? AND u.at <= ? ORDER BY u.at`,
      )
      .all(key, from, to) as Array<{ at: number; status: string | null; title: string }>
    for (const row of updates) {
      points.push({
        at: row.at,
        kind: row.status === 'fixed' ? 'resolved' : 'confirmed',
        detail: row.status === 'fixed' ? `${row.title} 已恢复` : `${row.title} 仍然存在`,
      })
    }

    return points.sort((left, right) => left.at - right.at)
  }

  /** The newest inspection pass, successful or not. */
  lastRun(): RunEvent | undefined {
    return this.runRow(
      this.db.prepare('SELECT id, at, trigger, health, blind_spots, notes, report_path FROM runs ORDER BY at DESC LIMIT 1').get(),
    )
  }

  /** The newest inspection that read every enabled collector successfully. */
  lastOkRun(): RunEvent | undefined {
    return this.runRow(
      this.db
        .prepare("SELECT id, at, trigger, health, blind_spots, notes, report_path FROM runs WHERE health = 'ok' ORDER BY at DESC LIMIT 1")
        .get(),
    )
  }

  private runRow(row: unknown): RunEvent | undefined {
    if (!row) return undefined
    const value = row as {
      id: string
      at: number
      trigger: string
      health: string
      blind_spots: string
      notes: string
      report_path: string | null
    }
    return {
      type: 'run',
      id: value.id,
      at: value.at,
      trigger: value.trigger,
      health: value.health as ObservationStatus,
      blindSpots: JSON.parse(value.blind_spots) as string[],
      notes: JSON.parse(value.notes) as string[],
      ...(value.report_path !== null ? { reportPath: value.report_path } : {}),
    }
  }

  close(): void {
    this.db.close()
    this.releaseLock()
  }
}
