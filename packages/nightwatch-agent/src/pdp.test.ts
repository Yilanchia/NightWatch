import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decide, policyGuard, WATCH_ACTIONS } from './pdp.js'

test('declared read-only watch tools are allowed', () => {
  for (const name of Object.keys(WATCH_ACTIONS)) {
    const decision = decide({ name })
    const operation = WATCH_ACTIONS[name]!.operation
    if (operation === 'read' || operation === 'note') {
      assert.equal(decision.allow, true, name)
    } else {
      assert.equal(decision.allow, false, name)
    }
  }
})

test('unknown tools are denied fail-closed, even with harmless names', () => {
  for (const name of ['probe_quiet_note', 'bash', 'write_file', 'plugin_install']) {
    const decision = decide({ name })
    assert.equal(decision.allow, false, name)
    assert.match(decision.reason ?? '', /未声明动作/)
  }
})

test('a write action needs the owner and is denied until approval exists', () => {
  const decision = decide({ name: 'watch_apply_fix' })
  assert.equal(decision.allow, false)
  assert.match(decision.reason ?? '', /审批|write/)
})

test('the guard returns a reason instead of throwing', () => {
  const guard = policyGuard()
  assert.equal(guard({ name: 'watch_health' } as never), undefined)
  const denied = guard({ name: 'probe_quiet_note' } as never)
  assert.equal(typeof denied, 'string')
  assert.match(denied!, /PDP/)
})
