import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectAll, type Runner } from './collect.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nightwatch-collect-'))
  const sshd = join(dir, 'sshd_config')
  const keys = join(dir, 'authorized_keys')
  writeFileSync(keys, '', 'utf8')
  return { dir, sshd, keys, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function config(sshd: string, keys: string) {
  return {
    ports: false,
    ssh: true,
    backup: false,
    backupPaths: [],
    sshdConfig: sshd,
    authorizedKeys: keys,
  }
}

test('Linux uses sshd -T so Include/Match/defaults are already resolved', () => {
  const { dir, sshd, keys, cleanup } = fixture()
  try {
    writeFileSync(sshd, 'PasswordAuthentication yes\n', 'utf8')
    const runner: Runner = (command, args) => {
      if (command === 'sshd' && args[0] === '-T') {
        return { exit: 0, stdout: 'passwordauthentication no\npermitrootlogin no\npermitemptypasswords no\n', stderr: '' }
      }
      return { exit: 127, stdout: '', stderr: '' }
    }
    const [observation] = collectAll(config(sshd, keys), { platform: 'linux', runner, now: 1 })
    assert.ok(observation)
    const password = observation.facts.find((fact) => fact.key === 'ssh:passwordauthentication')
    assert.equal(password?.value, 'no')
    assert.ok(observation.evidence.some((item) => item.command === 'sshd -T'))
    assert.equal(observation.status, 'ok')
  } finally {
    cleanup()
  }
})

test('when sshd -T is unavailable it falls back to the main file', () => {
  const { dir, sshd, keys, cleanup } = fixture()
  try {
    writeFileSync(sshd, 'PasswordAuthentication yes\n', 'utf8')
    const runner: Runner = (command) => (command === 'sshd' ? { exit: 1, stdout: '', stderr: 'no root' } : { exit: 127, stdout: '', stderr: '' })
    const [observation] = collectAll(config(sshd, keys), { platform: 'linux', runner, now: 1 })
    assert.ok(observation)
    const password = observation.facts.find((fact) => fact.key === 'ssh:passwordauthentication')
    assert.equal(password?.value, 'yes')
    assert.ok(observation.evidence.some((item) => item.command === `read ${sshd}`))
  } finally {
    cleanup()
  }
})
