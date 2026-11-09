/**
 * Collector health, derived from the evidence a collector produced.
 *
 * A read that failed is not a fact that disappeared. The report must be able to say
 * "this part was not read" instead of "nothing changed", so health is a first-class value
 * rather than something the rules infer ad hoc.
 */
import type { Evidence, Observation, ObservationStatus } from './types.js'

/** Health of one read, from its exit codes. No evidence means nothing was attempted. */
export function statusOf(evidence: readonly Evidence[]): ObservationStatus {
  if (evidence.length === 0) return 'ok'
  const failed = evidence.filter((read) => read.exit !== 0).length
  if (failed === 0) return 'ok'
  return failed === evidence.length ? 'failed' : 'partial'
}

/** Health of an observation. Older log records have no status, so derive it from evidence. */
export function observationStatus(observation: Observation): ObservationStatus {
  return observation.status ?? statusOf(observation.evidence)
}

/** The worst status wins when several collectors ran. */
export function overallStatus(observations: readonly Observation[]): ObservationStatus {
  const statuses = observations.map(observationStatus)
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('partial')) return 'partial'
  return 'ok'
}

/** Human-facing label used by reports and the CLI. */
export function statusLabel(status: ObservationStatus): string {
  switch (status) {
    case 'ok':
      return '正常'
    case 'partial':
      return '部分未读全'
    case 'failed':
      return '读取失败'
    case 'disabled':
      return '未启用'
  }
}
