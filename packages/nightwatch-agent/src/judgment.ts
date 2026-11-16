import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Finding } from './types.js'

/**
 * Structured investigation judgment (implementation plan §3.2).
 *
 * A judgment is the only thing the agent is allowed to produce besides proposals. It keeps the
 * observed/inferred split explicit: `confirmed` entries must point at a real observation id;
 * everything the model merely suspects lives in `candidates` with a likelihood. Missing evidence
 * goes to `gaps`, and the disposition tells the owner whether to act, wait, or stop and look.
 */

export type Disposition = 'propose' | 'escalate' | 'benign-pending-owner'
export type Confidence = 'low' | 'medium' | 'high'
export type Likelihood = 'low' | 'medium' | 'high'

export interface ConfirmedItem {
  readonly text: string
  /** Must reference an observation that exists in the store. */
  readonly evidenceRef: string
}

export interface CandidateItem {
  readonly text: string
  readonly likelihood: Likelihood
}

export interface JudgmentInput {
  readonly confirmed: readonly ConfirmedItem[]
  readonly candidates: readonly CandidateItem[]
  readonly counter: readonly string[]
  readonly gaps: readonly string[]
  readonly recommendation: string
  readonly disposition: Disposition
  readonly confidence: Confidence
}

export interface JudgmentBudget {
  readonly calls: number
  readonly ms: number
  readonly bytes: number
}

export interface InvestigationJudgment extends JudgmentInput {
  readonly type: 'investigation-judgment'
  readonly id: string
  readonly at: number
  readonly findingId: string
  readonly key: string
  readonly source: 'model'
  readonly model: string
  readonly budget: JudgmentBudget
}

export interface ValidationContext {
  readonly finding: Finding
  readonly observationExists: (id: string) => boolean
  readonly now: number
  readonly model: string
  readonly budget: JudgmentBudget
}

export interface ValidationResult {
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly judgment?: InvestigationJudgment
}

const DISPOSITIONS = new Set<Disposition>(['propose', 'escalate', 'benign-pending-owner'])
const CONFIDENCES = new Set<Confidence>(['low', 'medium', 'high'])
const LIKELIHOODS = new Set<Likelihood>(['low', 'medium', 'high'])

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '')
}

/** Validate model output before it is allowed to become a judgment. Pure and testable. */
export function validateJudgment(input: unknown, context: ValidationContext): ValidationResult {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) return { ok: false, errors: ['judgment 不是对象'] }
  const value = input as Record<string, unknown>

  if (!Array.isArray(value.confirmed)) errors.push('confirmed 必须是数组')
  const confirmed: ConfirmedItem[] = []
  if (Array.isArray(value.confirmed)) {
    for (const item of value.confirmed) {
      if (typeof item !== 'object' || item === null) {
        errors.push('confirmed 项必须是对象')
        continue
      }
      const entry = item as Record<string, unknown>
      if (typeof entry.text !== 'string' || entry.text.trim() === '') errors.push('confirmed.text 不能为空')
      if (typeof entry.evidenceRef !== 'string' || entry.evidenceRef.trim() === '') {
        errors.push('confirmed.evidenceRef 不能为空')
      } else if (!context.observationExists(entry.evidenceRef)) {
        errors.push(`confirmed.evidenceRef 指向不存在的观测：${entry.evidenceRef}`)
      }
      if (typeof entry.text === 'string' && typeof entry.evidenceRef === 'string') {
        confirmed.push({ text: entry.text, evidenceRef: entry.evidenceRef })
      }
    }
  }

  if (!Array.isArray(value.candidates)) errors.push('candidates 必须是数组')
  const candidates: CandidateItem[] = []
  if (Array.isArray(value.candidates)) {
    for (const item of value.candidates) {
      if (typeof item !== 'object' || item === null) {
        errors.push('candidates 项必须是对象')
        continue
      }
      const entry = item as Record<string, unknown>
      if (typeof entry.text !== 'string' || entry.text.trim() === '') errors.push('candidates.text 不能为空')
      if (typeof entry.likelihood !== 'string' || !LIKELIHOODS.has(entry.likelihood as Likelihood)) {
        errors.push('candidates.likelihood 必须是 low/medium/high')
      }
      if (typeof entry.text === 'string' && typeof entry.likelihood === 'string') {
        candidates.push({ text: entry.text, likelihood: entry.likelihood as Likelihood })
      }
    }
  }

  if (!isStringArray(value.counter)) errors.push('counter 必须是非空字符串数组')
  if (!isStringArray(value.gaps)) errors.push('gaps 必须是非空字符串数组')
  if (typeof value.recommendation !== 'string' || value.recommendation.trim() === '') {
    errors.push('recommendation 不能为空')
  }
  if (typeof value.disposition !== 'string' || !DISPOSITIONS.has(value.disposition as Disposition)) {
    errors.push('disposition 必须是 propose/escalate/benign-pending-owner')
  }
  if (typeof value.confidence !== 'string' || !CONFIDENCES.has(value.confidence as Confidence)) {
    errors.push('confidence 必须是 low/medium/high')
  }

  if (errors.length > 0) return { ok: false, errors }
  const judgment: InvestigationJudgment = {
    type: 'investigation-judgment',
    id: `judg-${context.now.toString(36)}-${randomUUID().slice(0, 8)}`,
    at: context.now,
    findingId: context.finding.id,
    key: context.finding.key,
    source: 'model',
    model: context.model,
    budget: context.budget,
    confirmed,
    candidates,
    counter: value.counter as string[],
    gaps: value.gaps as string[],
    recommendation: value.recommendation as string,
    disposition: value.disposition as Disposition,
    confidence: value.confidence as Confidence,
  }
  return { ok: true, errors: [], judgment }
}

export function appendJudgment(path: string, judgment: InvestigationJudgment): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(judgment)}\n`, 'utf8')
}

export function loadJudgments(path: string): InvestigationJudgment[] {
  if (!existsSync(path)) return []
  const judgments: InvestigationJudgment[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as InvestigationJudgment
      if (parsed.type === 'investigation-judgment') judgments.push(parsed)
    } catch {
      // Append-only history: a malformed line should not hide later judgments.
    }
  }
  return judgments
}

/** Latest judgment per finding, plus the full history in file order. */
export function judgmentsByFinding(path: string): Map<string, InvestigationJudgment[]> {
  const grouped = new Map<string, InvestigationJudgment[]>()
  for (const judgment of loadJudgments(path)) {
    const list = grouped.get(judgment.findingId) ?? []
    list.push(judgment)
    grouped.set(judgment.findingId, list)
  }
  return grouped
}
