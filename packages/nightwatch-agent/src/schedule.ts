/**
 * Scheduling arithmetic for the built-in daemon. Pure functions so the restart/catch-up rules can
 * be tested without waiting a day.
 *
 * Rules (from the plan doc):
 * - after a restart, a missed run is caught up once, never replayed as fake history;
 * - the loop never overlaps itself: one inspection at a time;
 * - `nextRunAt` is derived from the last recorded run, so a crash does not drift the cadence.
 */

/** Is a run due now? No previous run means yes (first boot must start watching). */
export function isDue(lastRunAt: number | undefined, now: number, intervalMs: number): boolean {
  if (lastRunAt === undefined) return true
  return now - lastRunAt >= intervalMs
}

/** When the next run should happen, given the last one. Overdue collapses to "now". */
export function nextRunAt(lastRunAt: number | undefined, now: number, intervalMs: number): number {
  if (lastRunAt === undefined) return now
  return Math.max(now, lastRunAt + intervalMs)
}
