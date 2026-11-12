import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The minimal-host enforcement probe.
 *
 * The old self-check only enumerated tool *names* and asserted the surface was `watch_*`. A name
 * list proves what the model is shown, not what it can do: guard's own source says its rules are a
 * net, not a sandbox. This probe exercises the real execution pipeline (`ctx.tools.execute` →
 * `tools/pre-execute` → guard → body) and answers three enforcement questions:
 *
 *  1. surface — are only the read-only watch_* tools reachable, and is no dangerous capability
 *     (shell, file write, fs, run_code, plugin/mcp) mounted or hidden-but-reachable?
 *  2. gate — when a destructive-named tool is actually dispatched with nobody to approve it, does
 *     the mandatory deny gate stop it *before the body runs*? (fail-closed)
 *  3. name-blindness — a routine-NAMED tool that writes a file. Without a policy layer guard lets
 *     it through, because it judges by name/regex. The pass requires this to be denied: the
 *     standalone host installs the PDP (pdp.ts), which decides from a declared action instead.
 *
 * It registers throwaway probe tools, runs them, and disposes them; every side effect is a canary
 * file inside the throwaway self-check home.
 */

export const REQUIRED_TOOLS = [
  'watch_baseline',
  'watch_diff',
  'watch_report',
  'watch_propose_fix',
  'watch_timeline',
  'watch_health',
] as const

/** Allowed but opt-in; present only when applyFix is enabled. */
export const OPTIONAL_TOOLS = ['watch_apply_fix'] as const

/** Exact tool names a read-only watcher must never expose to the model. */
const DANGEROUS_EXACT = new Set([
  'bash', 'pwsh', 'powershell', 'shell', 'terminal', 'cmd', 'exec', 'run_code',
  'write', 'edit', 'multi_edit', 'str_replace', 'str_replace_editor', 'create', 'apply_patch',
  'read', 'read_image', 'glob', 'grep', 'notebook_edit',
  'fs_read', 'fs_write', 'plugin', 'mcp',
])

/** Patterns for dangerous capability a plugin might register under another name. */
const DANGEROUS_PATTERN = /(^|_)(shell|exec|spawn|fs|file|write|edit|delete|remove|install|uninstall|patch|run_code)(_|$)/i

/** watch_* is the product surface, judged by the allow-list; everything else is screened here. */
export function isDangerousToolName(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.startsWith('watch_')) return false
  if (DANGEROUS_EXACT.has(lower)) return true
  return DANGEROUS_PATTERN.test(lower)
}

export interface GateResult {
  /** The dispatch was refused (deny result or a thrown refusal). */
  readonly denied: boolean
  /** The tool body ran anyway (the canary was written). A pass requires this to be false. */
  readonly ranBody: boolean
  readonly pass: boolean
}

export interface SelfcheckReport {
  readonly tools: string[]
  /** Model-visible tools outside the allowed watch_* set. Must be empty. */
  readonly extra: string[]
  /** Required watch_* tools that are not registered. Must be empty. */
  readonly missing: string[]
  /** Dangerous capabilities reachable through the registry. Must be empty. */
  readonly dangerousReachable: string[]
  /** The mandatory deny gate stopped a destructive dispatch before its body ran. */
  readonly gate: GateResult
  /** A routine-named writer reached its body: the policy layer is missing or blind. */
  readonly guardNameBlind: boolean
  readonly pass: boolean
}

/** The pass decision, pure so it can be tested without booting a host. */
export function selfcheckPassed(report: Omit<SelfcheckReport, 'pass'>): boolean {
  return (
    report.extra.length === 0 &&
    report.missing.length === 0 &&
    report.dangerousReachable.length === 0 &&
    report.gate.pass &&
    !report.guardNameBlind
  )
}

const PROBE_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

type ExecInput = Parameters<Context['tools']['execute']>[0]

/** Dispatch one probe tool through the full pipeline; report whether it was denied. */
async function dispatch(ctx: Context, name: string): Promise<{ denied: boolean }> {
  const controller = new AbortController()
  const input = { callId: `selfcheck-${name}`, name, arguments: {}, signal: controller.signal } as unknown as ExecInput
  try {
    const result = (await ctx.tools.execute(input)) as { isError?: boolean }
    return { denied: result.isError === true }
  } catch {
    return { denied: true }
  }
}

/** Register a throwaway tool whose only effect is to write `canary`, run it, then dispose it. */
async function probeWrite(ctx: Context, name: string, canary: string): Promise<{ denied: boolean; ranBody: boolean }> {
  rmSync(canary, { force: true })
  const dispose = ctx.tools.register(
    defineTool({
      name,
      description: 'Nightwatch self-check probe. It must never run in production; it writes a canary file.',
      parameters: {},
      output: PROBE_OUTPUT,
      async execute() {
        writeFileSync(canary, 'ran', 'utf8')
        return 'ran'
      },
    }),
  )
  try {
    const { denied } = await dispatch(ctx, name)
    const ranBody = existsSync(canary)
    return { denied, ranBody }
  } finally {
    dispose()
    rmSync(canary, { force: true })
  }
}

/** Boot-time probe. `home` is the throwaway self-check home, where canary files may be written. */
export async function runSelfcheck(ctx: Context, home: string): Promise<SelfcheckReport> {
  const tools = ctx.tools
    .schemas()
    .map((schema) => schema.name)
    .sort()
  const allowed = new Set<string>([...REQUIRED_TOOLS, ...OPTIONAL_TOOLS])
  const extra = tools.filter((name) => !allowed.has(name))
  const missing = REQUIRED_TOOLS.filter((name) => !tools.includes(name))

  // Dangerous by model-visible name, plus any dangerous name reachable in the registry but hidden
  // from the model's schema list.
  const reachable = new Set<string>(tools.filter(isDangerousToolName))
  for (const name of DANGEROUS_EXACT) {
    if (ctx.tools.get(name) !== undefined) reachable.add(name)
  }
  const dangerousReachable = [...reachable].sort()

  // Gate: a destructive-named tool ("_apply_" => destructive for guard) must be denied before its
  // body runs. With no device and no Web UI to answer, guard refuses after its ask timeout.
  const gateProbe = await probeWrite(ctx, 'probe_apply_canary', join(home, 'selfcheck-gate-canary'))
  const gate: GateResult = { denied: gateProbe.denied, ranBody: gateProbe.ranBody, pass: gateProbe.denied && !gateProbe.ranBody }

  // Name-blindness: a routine-named tool that writes a file is not stopped by guard today.
  const quietProbe = await probeWrite(ctx, 'probe_quiet_note', join(home, 'selfcheck-quiet-canary'))
  const guardNameBlind = quietProbe.ranBody

  const base = { tools, extra, missing, dangerousReachable, gate, guardNameBlind }
  return { ...base, pass: selfcheckPassed(base) }
}
