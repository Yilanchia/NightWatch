import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isDue, nextRunAt } from './schedule.js'

const at = 1_800_000_000_000
const hour = 3_600_000

test('no recorded run means run immediately', () => {
  assert.equal(isDue(undefined, at, 24 * hour), true)
  assert.equal(nextRunAt(undefined, at, 24 * hour), at)
})

test('an overdue run is caught up now, not scheduled in the past', () => {
  assert.equal(isDue(at - 30 * hour, at, 24 * hour), true)
  assert.equal(nextRunAt(at - 30 * hour, at, 24 * hour), at)
})

test('a fresh run waits for the interval', () => {
  assert.equal(isDue(at - hour, at, 24 * hour), false)
  assert.equal(nextRunAt(at - hour, at, 24 * hour), at + 23 * hour)
})

test('exactly on the interval boundary counts as due', () => {
  assert.equal(isDue(at - 24 * hour, at, 24 * hour), true)
})
