import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redactContent, redactText } from './projection.js'

test('canary markers, keys and paths do not survive projection', () => {
  const text = 'detail NW-CANARY-7f3a at /root/.ssh/authorized_keys; key -----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'
  const redacted = redactText(text)
  assert.equal(redacted.includes('NW-CANARY-7f3a'), false)
  assert.equal(redacted.includes('/root/.ssh/authorized_keys'), false)
  assert.equal(redacted.includes('PRIVATE KEY'), false)
  assert.match(redacted, /REDACTED:canary/)
  assert.match(redacted, /REDACTED:path/)
})

test('token-looking values are redacted, ordinary text is not', () => {
  const text = 'Authorization: Bearer abcdef0123456789 and port 22 is open'
  const redacted = redactText(text)
  assert.equal(redacted.includes('abcdef0123456789'), false)
  assert.match(redacted, /port 22 is open/)
})

test('content blocks only rewrite text blocks', () => {
  const blocks = [
    { type: 'text', text: 'canary NW-CANARY-abc123' },
    { type: 'image', data: 'x' },
  ]
  const out = redactContent(blocks)
  assert.equal(out[0]!.text, 'canary [REDACTED:canary]')
  assert.deepEqual(out[1], blocks[1])
})
