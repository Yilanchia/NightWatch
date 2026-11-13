import type { Context } from '@deepseek-ai/cordis'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'

/**
 * Model-facing projection layer (egress redaction prototype).
 *
 * The deterministic store keeps full evidence; this layer only rewrites what a model is about to
 * receive from a watch_* tool call. It is deliberately narrow and testable:
 *   - private key blocks
 *   - canary/secret tokens (the egress probe's marker)
 *   - bearer/token-looking values
 *   - absolute paths (home/root/etc/var/opt/tmp and drive-letter paths)
 *
 * It is not a general DLP engine. Unknown text passes through, so the probe's job is to keep
 * extending these rules until a canary cannot ride along.
 */

export interface RedactionRule {
  readonly name: string
  readonly pattern: RegExp
  readonly replacement: string
}

export const DEFAULT_RULES: readonly RedactionRule[] = [
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:private-key]',
  },
  {
    name: 'canary',
    pattern: /\bNW-CANARY-[A-Za-z0-9-]+/g,
    replacement: '[REDACTED:canary]',
  },
  {
    name: 'token',
    pattern: /\b(?:Bearer|token[=:])\s*[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: '[REDACTED:token]',
  },
  {
    name: 'path',
    pattern: /(?:[A-Za-z]:\\[^\s"'`]+|\/(?:home|root|etc|var|opt|Users|tmp)\/[^\s"'`]+)/g,
    replacement: '[REDACTED:path]',
  },
]

/** Redact known sensitive shapes. Pure and idempotent enough for tool-result projection. */
export function redactText(text: string, rules: readonly RedactionRule[] = DEFAULT_RULES): string {
  let result = text
  for (const rule of rules) result = result.replace(rule.pattern, rule.replacement)
  return result
}

export interface ProjectableBlock {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

export function redactContent(content: readonly ProjectableBlock[], rules: readonly RedactionRule[] = DEFAULT_RULES): ProjectableBlock[] {
  return content.map((block) =>
    block.type === 'text' && typeof block.text === 'string' ? { ...block, text: redactText(block.text, rules) } : block,
  )
}

/**
 * Register the projection on the tool pipeline. It runs after the tool body and after every other
 * post-execute listener; only `watch_*` successes are rewritten, and only their model-facing copy
 * (the durable log is not touched here).
 */
export function installProjection(ctx: Context, rules: readonly RedactionRule[] = DEFAULT_RULES): () => void {
  return ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || !exec.name.startsWith('watch_') || !Array.isArray(result.content)) return decision
    return { kind: 'accept', content: redactContent(result.content as unknown as ProjectableBlock[], rules) } as unknown as PostToolDecision
  })
}
