import type { WatchStore } from './store.js'
import type { WatchConfig } from './tools.js'
import type { Finding } from './types.js'
import { inspectionHealth, formatHealth } from './inspect.js'
import { queryTimeline, renderTimeline } from './timeline.js'
import {
  appendJudgment,
  validateJudgment,
  type InvestigationJudgment,
  type JudgmentInput,
} from './judgment.js'

/**
 * The investigation loop shared by the stub reasoner and the model path.
 *
 * It owns the budget and the read whitelist; the reasoner only says what to read next or that it
 * is ready to conclude. The loop validates the conclusion against the store before writing it, so
 * "confirmed" can never point at an observation that does not exist.
 */

export interface AgentRead {
  readonly tool: 'timeline' | 'health'
  readonly text: string
  readonly bytes: number
  readonly at: number
}

export type AgentDecision =
  | { readonly action: 'read'; readonly tool: 'timeline'; readonly key: string; readonly days?: number }
  | { readonly action: 'read'; readonly tool: 'health' }
  | { readonly action: 'conclude'; readonly judgment: JudgmentInput }

export interface Reasoner {
  decide(input: { readonly finding: Finding; readonly reads: readonly AgentRead[] }): Promise<AgentDecision>
}

export interface InvestigationOptions {
  readonly reasoner: Reasoner
  readonly judgmentsPath: string
  readonly now: number
  readonly calls: number
  readonly ms: number
  readonly bytes: number
  readonly model: string
}

export interface InvestigationResult {
  readonly status: 'concluded' | 'budget' | 'invalid' | 'error'
  readonly judgment?: InvestigationJudgment
  readonly errors?: readonly string[]
  readonly reads: readonly AgentRead[]
  readonly detail: string
}

export async function investigateFinding(
  store: WatchStore,
  config: WatchConfig,
  findingId: string,
  options: InvestigationOptions,
): Promise<InvestigationResult> {
  const finding = store.findings('id = ?', findingId)[0]
  if (!finding) return { status: 'error', reads: [], detail: `没有找到发现 ${findingId}` }

  const reads: AgentRead[] = []
  const startedAt = options.now
  let calls = 0
  let bytes = 0

  while (calls < options.calls) {
    if (Date.now() - startedAt > options.ms) {
      return { status: 'budget', reads, detail: `墙钟超过 ${Math.round(options.ms / 1000)} 秒` }
    }
    const decision = await options.reasoner.decide({ finding, reads })
    if (decision.action === 'conclude') {
      const validation = validateJudgment(decision.judgment, {
        finding,
        observationExists: (id) => store.observationById(id) !== undefined,
        now: options.now,
        model: options.model,
        budget: { calls, ms: Date.now() - startedAt, bytes },
      })
      if (!validation.ok || !validation.judgment) {
        return { status: 'invalid', reads, errors: validation.errors, detail: validation.errors.join('；') }
      }
      appendJudgment(options.judgmentsPath, validation.judgment)
      return { status: 'concluded', judgment: validation.judgment, reads, detail: '已记录调查判断' }
    }

    let text: string
    if (decision.tool === 'timeline') {
      text = renderTimeline(queryTimeline(store, decision.key, decision.days ?? 7, options.now))
    } else {
      text = formatHealth(inspectionHealth(store, config, options.now))
    }
    calls += 1
    const size = Buffer.byteLength(text)
    bytes += size
    reads.push({ tool: decision.tool, text, bytes: size, at: options.now })
    if (bytes > options.bytes) {
      return { status: 'budget', reads, detail: `返回数据超过 ${options.bytes} 字节` }
    }
  }

  return { status: 'budget', reads, detail: `工具调用达到 ${options.calls} 次` }
}
