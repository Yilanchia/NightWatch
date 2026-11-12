import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDangerousToolName, selfcheckPassed, REQUIRED_TOOLS, type GateResult } from './selfcheck.js'

const okGate: GateResult = { denied: true, ranBody: false, pass: true }
const badGate: GateResult = { denied: false, ranBody: true, pass: false }

test('watch_* tools are never flagged dangerous — they are the product surface', () => {
  for (const name of REQUIRED_TOOLS) assert.equal(isDangerousToolName(name), false)
  assert.equal(isDangerousToolName('watch_apply_fix'), false)
})

test('shell, write, fs and run_code tools are flagged dangerous', () => {
  for (const name of ['bash', 'pwsh', 'powershell', 'shell', 'terminal', 'write', 'edit', 'str_replace_editor', 'run_code', 'fs_write', 'fs_read', 'apply_patch']) {
    assert.equal(isDangerousToolName(name), true, `${name} should be dangerous`)
  }
})

test('dangerous capability under another name is caught by pattern', () => {
  for (const name of ['plugin_install', 'exec_command', 'file_delete', 'remote_shell', 'mcp_fs']) {
    assert.equal(isDangerousToolName(name), true, `${name} should be dangerous`)
  }
})

test('harmless read-only / routine tools are not flagged', () => {
  for (const name of ['ask_user_question', 'compact', 'web_search', 'schedule_list']) {
    assert.equal(isDangerousToolName(name), false, `${name} should be allowed`)
  }
})

test('pass requires a clean surface, a working deny gate and no name blindness', () => {
  assert.equal(selfcheckPassed({ tools: [], extra: [], missing: [], dangerousReachable: [], gate: okGate, guardNameBlind: false }), true)
  assert.equal(selfcheckPassed({ tools: [], extra: [], missing: [], dangerousReachable: [], gate: okGate, guardNameBlind: true }), false)
})

test('any surface defect or a bypassed gate fails the check', () => {
  const clean = { tools: [], extra: [], missing: [], dangerousReachable: [], gate: okGate, guardNameBlind: false }
  assert.equal(selfcheckPassed({ ...clean, extra: ['bash'] }), false)
  assert.equal(selfcheckPassed({ ...clean, missing: ['watch_diff'] }), false)
  assert.equal(selfcheckPassed({ ...clean, dangerousReachable: ['pwsh'] }), false)
  assert.equal(selfcheckPassed({ ...clean, gate: badGate }), false)
})

test('closing the name blindness (PDP) is required for a pass', () => {
  const base = { tools: [], extra: [], missing: [], dangerousReachable: [], gate: okGate }
  assert.equal(selfcheckPassed({ ...base, guardNameBlind: true }), false)
  assert.equal(selfcheckPassed({ ...base, guardNameBlind: false }), true)
})
