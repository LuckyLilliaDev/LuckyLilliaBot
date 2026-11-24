import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayAuth, hashPassword } from '@/main/manager/auth'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'llbot-gateway-auth-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const file = () => path.join(dir, 'webui_token.txt')

describe('the one WebUI login of all instances', () => {
  it('takes the first instance password there is, the default instance\'s first', () => {
    for (const [name, password] of [['default', ''], ['bot2', 'two'], ['bot3', 'three']]) {
      mkdirSync(path.join(dir, name))
      writeFileSync(path.join(dir, name, 'webui_token.txt'), password)
    }
    const log = { info: vi.fn(), warn: vi.fn() }
    const auth = new GatewayAuth({ file: file(), migrateFrom: () => ['default', 'bot2', 'bot3'].map(n => path.join(dir, n, 'webui_token.txt')), log })
    expect(auth.getToken()).toBe('two')
    expect(readFileSync(file(), 'utf8')).toBe('two')
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('其他实例原来的密码不再使用'))
  })

  it('keeps a password it already has', () => {
    writeFileSync(file(), 'mine\n')
    writeFileSync(path.join(dir, 'other.txt'), 'other')
    expect(new GatewayAuth({ file: file(), migrateFrom: () => [path.join(dir, 'other.txt')] }).getToken()).toBe('mine')
  })

  it('asks for a first password, then for the password, then lets the right one through', () => {
    const auth = new GatewayAuth({ file: file() })
    expect(auth.check(undefined, 'ip', 'GET', '/api/x')).toMatchObject({ status: 401, reason: 'unset' })
    auth.setToken('secret')
    expect(auth.check(undefined, 'ip', 'GET', '/api/x')).toMatchObject({ status: 403, reason: 'required' })
    expect(auth.check(hashPassword('secret'), 'ip', 'GET', '/api/x')).toBeUndefined()
    expect(auth.matches(hashPassword('secret'))).toBe(true)
    expect(auth.matches('nope')).toBe(false)
  })

  it('locks for an hour after four wrong passwords in a row, the right one included', () => {
    let now = 1_000_000
    const auth = new GatewayAuth({ file: file(), now: () => now })
    auth.setToken('secret')
    for (let i = 1; i < 4; i++) expect(auth.check('wrong', 'ip', 'GET', '/api/x')).toMatchObject({ reason: 'wrong', body: { remainingAttempts: 4 - i } })
    expect(auth.check('wrong', 'ip', 'GET', '/api/x')).toMatchObject({ status: 403, reason: 'locked' })
    expect(auth.check(hashPassword('secret'), 'ip', 'GET', '/api/x')).toMatchObject({ reason: 'locked' })
    // Only checking quietly does not count, and does not get around the lock either
    expect(auth.matches(hashPassword('secret'))).toBe(true)
    now += 60 * 60 * 1000
    expect(auth.check(hashPassword('secret'), 'ip', 'GET', '/api/x')).toBeUndefined()
  })

  it('reads a password changed on disk', async () => {
    const auth = new GatewayAuth({ file: file() })
    auth.setToken('first')
    await new Promise(resolve => setTimeout(resolve, 20))
    writeFileSync(file(), 'second')
    expect(auth.getToken()).toBe('second')
  })

  it('writes the access log when asked to', () => {
    const accessLog = path.join(dir, 'access.log')
    const auth = new GatewayAuth({ file: file(), accessLog })
    auth.check(undefined, '1.2.3.4', 'GET', '/api/x')
    expect(readFileSync(accessLog, 'utf8')).toContain('IP: 1.2.3.4 | GET /api/x | Status: 401')
  })
})
