import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute, dirname } from 'node:path'
import { installPolicy } from './pdp.js'
import { WatchStore } from './store.js'
import { registerTools, type WatchConfig } from './tools.js'

export { applyProposal } from './apply.js'
export { collectAll, defaultRunner, type CollectorConfig, type RunResult, type Runner } from './collect.js'
export {
  correlate,
  emptyState,
  ingestBundle,
  registerNode,
  type CoordinatorFinding,
  type CoordinatorNode,
  type CoordinatorState,
  type CorrelatedGroup,
  type IngestResult,
  type RegisterResult,
} from './coordinator.js'
export {
  buildBundle,
  canonicalJson,
  verifyBundle,
  type BundleCapabilities,
  type BundleFinding,
  type BundleHealth,
  type BundlePayload,
  type BundleRun,
  type NodeBundle,
  type VerifyResult,
} from './export.js'
export { observationStatus, overallStatus, statusLabel, statusOf } from './health.js'
export { ensureIdentity, nodeIdFor, signPayload, verifyPayload, type NodeIdentity } from './identity.js'
export {
  formatHealth,
  formatInspection,
  inspectionHealth,
  localDay,
  runInspection,
  takeBaseline,
  takeDiff,
  writeReport,
  type CollectorHealth,
  type HealthSummary,
  type InspectionOptions,
  type InspectionResult,
} from './inspect.js'
export { listenFacts, parseAuthorizedKeys, parseSshdConfig, parseSsListen, parseWindowsListen } from './parse.js'
export { buildProposal, formatProposal } from './propose.js'
export { diffFacts, diffSnapshot, mapByKey } from './rules.js'
export { renderReport } from './report.js'
export { WatchStore } from './store.js'
export { queryTimeline, renderTimeline, timelineText, type TimelineResult } from './timeline.js'
export { localStamp } from './time.js'
export { startCoordinatorServer, type CoordinatorServer, type CoordinatorServerOptions } from './transport.js'
export { proposeFix, applyFix, type WatchConfig, type WatchContext } from './tools.js'
export type {
  Baseline,
  Epistemic,
  Fact,
  Finding,
  FindingStatus,
  FixAction,
  FixChange,
  FixProposal,
  Observation,
  ObservationStatus,
  RunEvent,
  Severity,
  Snapshot,
  TimelinePoint,
  WatchEvent,
} from './types.js'

/**
 * Nightwatch: a read-only defence layer for the machine she lives on.
 *
 * It keeps an append-only evidence log next to her life (never inside it), folds it into a
 * SQLite view, takes a baseline, and reports what changed. Every command is fixed here; the model
 * can choose a check and read the result, never write a command. Anything that would change the
 * system is deliberately absent: fixing is a proposal the owner approves, not a tool.
 */
export const name = 'nightwatch'
export const inject = ['tools']

export interface Config {
  /** Absolute path of the append-only evidence log (JSON Lines). */
  readonly evidencePath: string
  /** Absolute path of the SQLite view; deleting it rebuilds from the log. */
  readonly databasePath: string
  /** Absolute directory the daily Markdown reports are written to. */
  readonly reportDir: string
  readonly ports: boolean
  readonly ssh: boolean
  readonly backup: boolean
  /** Files or directories whose newest file is checked as "the backup". Empty skips the check. */
  readonly backupPaths: string[]
  /** A backup older than this many hours is a finding. */
  readonly backupStaleHours: number
  /** A successful read older than this many hours is reported as stale, not as current. */
  readonly observationValidHours: number
  /** Defaults to the platform's sshd_config. */
  readonly sshdConfig?: string
  /** Defaults to `~/.ssh/authorized_keys`. */
  readonly authorizedKeys?: string
  /**
   * Register the repair executor. Off by default: a read-only watcher should not carry a key that
   * can edit sshd_config until the owner explicitly asks for it.
   */
  readonly applyFix: boolean
  /**
   * Install the policy decision point: only explicitly declared read-only tools are allowed;
   * unknown, write and approval-required tools are denied before their body runs.
   */
  readonly pdp: boolean
}

export const Config: z<Config> = z.object({
  evidencePath: z.string().required().description('Absolute path of the read-only evidence log (JSON Lines).'),
  databasePath: z.string().required().description('Absolute path of the SQLite view; deleted and rebuilt from the log.'),
  reportDir: z.string().required().description('Absolute directory for the daily Markdown reports.'),
  ports: z.boolean().default(true).description('Collect listening sockets.'),
  ssh: z.boolean().default(true).description('Read sshd_config and authorized_keys.'),
  backup: z.boolean().default(true).description('Check the newest file under backupPaths.'),
  backupPaths: z.array(z.string()).default([]).description('Files or directories to treat as backups.'),
  backupStaleHours: z.natural().default(36).description('A backup older than this many hours is a finding.'),
  observationValidHours: z.natural().default(26).description('A successful read older than this is reported as stale data.'),
  sshdConfig: z.string().description('sshd_config path; platform default when absent.'),
  authorizedKeys: z.string().description('authorized_keys path; ~/.ssh/authorized_keys when absent.'),
  applyFix: z.boolean().default(false).description('Register watch_apply_fix. Keep it off unless the owner explicitly wants repairs.'),
  pdp: z.boolean().default(false).description('Install the policy decision point: deny tools without a declared read-only action.'),
})

export function apply(ctx: Context, config: Config): void {
  for (const path of [config.evidencePath, config.databasePath, config.reportDir]) {
    if (!isAbsolute(path)) {
      throw new Error(`nightwatch: expected an absolute path, got ${JSON.stringify(path)}`)
    }
  }

  const store = new WatchStore(config.evidencePath, config.databasePath)
  const watchConfig: WatchConfig = {
    evidencePath: config.evidencePath,
    databasePath: config.databasePath,
    reportDir: config.reportDir,
    ports: config.ports,
    ssh: config.ssh,
    backup: config.backup,
    backupPaths: config.backupPaths,
    backupStaleHours: config.backupStaleHours,
    observationValidHours: config.observationValidHours,
    applyFix: config.applyFix,
    ...(config.sshdConfig ? { sshdConfig: config.sshdConfig } : {}),
    ...(config.authorizedKeys ? { authorizedKeys: config.authorizedKeys } : {}),
  }

  registerTools(ctx, { store, config: watchConfig })
  if (config.pdp) ctx.effect(() => installPolicy(ctx), 'nightwatch.pdp')
  ctx.effect(() => () => store.close(), 'nightwatch.store')

  const enabled = [config.ports ? 'ports' : '', config.ssh ? 'ssh' : '', config.backup ? 'backup' : ''].filter(Boolean)
  ctx.logger.info(
    `nightwatch: watching ${enabled.length > 0 ? enabled.join('/') : 'nothing'} — evidence ${config.evidencePath}, reports ${config.reportDir}`,
  )

  // Used by the minimal-host self-check: after every plugin has mounted, run the enforcement probe
  // (tool surface + mandatory deny gate + name-blindness evidence) and exit. The environment gate
  // keeps this out of normal runs. The 1.5s wait lets guard and the sibling plugins mount first.
  if (process.env.NIGHTWATCH_SELFCHECK === '1') {
    setTimeout(() => {
      void (async () => {
        const { runSelfcheck } = await import('./selfcheck.js')
        const report = await runSelfcheck(ctx, dirname(config.evidencePath))
        console.log(`nightwatch-selfcheck ${JSON.stringify(report)}`)
        process.exit(report.pass ? 0 : 1)
      })().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        console.log(`nightwatch-selfcheck ${JSON.stringify({ error: reason, tools: [], extra: [], missing: ['<probe crashed>'], pass: false })}`)
        process.exit(1)
      })
    }, 1500)
  }
}
