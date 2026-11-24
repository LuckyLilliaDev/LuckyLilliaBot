import { describe, expect, it } from 'vitest'
import Schema from 'schemastery'
import { hydrate } from '@/common/schema/model'
import { applyConfigPatches } from '@/common/schema/patch'

const schemaOf = (s: Schema) => hydrate(s.toJSON() as { uid: number; refs: Record<string, unknown> })

describe('schema-aware config patching', () => {
  const SampleSchema = Schema.object({
    appId: Schema.string().default('').description('机器人 AppID'),
    secret: Schema.string().role('secret').default('').description('密钥'),
    port: Schema.natural().default(5500).description('监听端口'),
    sandbox: Schema.boolean().default(false).description('连接沙箱环境'),
    mode: Schema.union([
      Schema.const('private').description('私域'),
      Schema.const('public').description('公域'),
    ]).default('private').description('运行模式'),
    prefixes: Schema.array(Schema.string()).default(['/']).description('指令前缀'),
    codes: Schema.array(Schema.natural()).default([]).description('状态码'),
    nested: Schema.object({
      host: Schema.string().default('127.0.0.1').description('监听地址'),
      retries: Schema.number().default(3).description('重试次数'),
    }).default({ host: '127.0.0.1', retries: 3 }),
    connect: Schema.array(Schema.object({
      type: Schema.string().default('ws'),
      enable: Schema.boolean().default(false),
      url: Schema.string().default(''),
    })).default([{ type: 'ws', enable: false, url: '' }]),
  })

  const node = schemaOf(SampleSchema)
  const base = SampleSchema({})

  it('coerces path values using the schema without mis-typing numeric strings', () => {
    const next = applyConfigPatches(base, node, [
      { kind: 'set', path: ['appId'], raw: '102000001' },
      { kind: 'set', path: ['secret'], raw: 'true' },
      { kind: 'set', path: ['port'], raw: '8080' },
      { kind: 'set', path: ['sandbox'], raw: 'yes' },
      { kind: 'set', path: ['mode'], raw: 'public' },
      { kind: 'set', path: ['prefixes'], raw: '!, /' },
      { kind: 'set', path: ['codes'], raw: '1001,1002' },
      { kind: 'set', path: ['nested', 'host'], raw: '0.0.0.0' },
      { kind: 'set', path: ['nested', 'retries'], raw: '5' },
    ])

    expect(next).toMatchObject({
      appId: '102000001',
      secret: 'true',
      port: 8080,
      sandbox: true,
      mode: 'public',
      prefixes: ['!', '/'],
      codes: [1001, 1002],
      nested: { host: '0.0.0.0', retries: 5 },
    })
  })

  it('supports JSON arrays, array element patching, appending and empty-string clearing', () => {
    const next = applyConfigPatches(base, node, [
      { kind: 'set', path: ['prefixes'], raw: '["#", "!"]' },
      { kind: 'set', path: ['connect', '0', 'enable'], raw: 'true' },
      { kind: 'set', path: ['connect', '0', 'url'], raw: 'ws://127.0.0.1:8080/onebot' },
      { kind: 'set', path: ['connect', '1'], raw: "{type:'http',enable:true,url:'http://127.0.0.1:3000'}" },
      { kind: 'set', path: ['appId'], raw: '' },
    ])

    expect(next.prefixes).toEqual(['#', '!'])
    expect(next.appId).toBe('')
    expect(next.connect).toEqual([
      { type: 'ws', enable: true, url: 'ws://127.0.0.1:8080/onebot' },
      { type: 'http', enable: true, url: 'http://127.0.0.1:3000' },
    ])
  })

  it('deep-merges JSON objects while preserving untouched sibling fields and secrets', () => {
    const existing = { ...base, secret: 'keep-me', nested: { host: '127.0.0.1', retries: 9 } }
    const next = applyConfigPatches(existing, node, [
      { kind: 'merge', value: { port: 6000, nested: { host: '0.0.0.0' } } },
    ])
    expect(next.secret).toBe('keep-me')
    expect(next.port).toBe(6000)
    expect(next.nested).toEqual({ host: '0.0.0.0', retries: 9 })
  })

  it('gives friendly errors for unknown fields, bad types, enum choices and out-of-range array indices', () => {
    expect(() => applyConfigPatches(base, node, [{ kind: 'set', path: ['appid'], raw: '123' }]))
      .toThrow(/没有配置项「appid」.*appId（机器人 AppID）/)
    expect(() => applyConfigPatches(base, node, [{ kind: 'merge', value: { unknownKey: 1 } }]))
      .toThrow(/没有配置项「unknownKey」.*可用字段/)
    expect(() => applyConfigPatches(base, node, [{ kind: 'set', path: ['sandbox'], raw: 'maybe' }]))
      .toThrow(/需要布尔值/)
    expect(() => applyConfigPatches(base, node, [{ kind: 'set', path: ['port'], raw: 'abc' }]))
      .toThrow(/需要数字/)
    expect(() => applyConfigPatches(base, node, [{ kind: 'set', path: ['mode'], raw: 'invalid' }]))
      .toThrow(/可选值为 private \/ public/)
    expect(() => applyConfigPatches(base, node, [{ kind: 'set', path: ['connect', '5', 'url'], raw: 'ws://x' }]))
      .toThrow(/数组下标越界/)
  })

  it('rejects prototype pollution keys in both paths and merged JSON', () => {
    expect(() => applyConfigPatches(base, null, [{ kind: 'set', path: ['__proto__', 'polluted'], raw: 'true' }]))
      .toThrow(/非法段/)
    expect(() => applyConfigPatches(base, null, [{ kind: 'merge', value: JSON.parse('{"__proto__":{"polluted":true}}') }]))
      .toThrow(/非法键名/)
  })

  it('deep-merges multi-level objects via dot paths, sub-path JSON and root JSON while validating nested keys', () => {
    const DeepSchema = Schema.object({
      smtp: Schema.object({
        host: Schema.string().default(''),
        port: Schema.natural().default(587),
        auth: Schema.object({
          user: Schema.string().default('').description('用户名'),
          pass: Schema.string().role('secret').default('').description('密码'),
        }),
      }),
      groups: Schema.dict(Schema.object({
        enabled: Schema.boolean().default(true),
        reply: Schema.object({
          prefix: Schema.string().default(''),
        }),
      })).default({}),
    })
    const deepNode = schemaOf(DeepSchema)
    const initial = {
      smtp: { host: 'smtp.example.com', port: 587, auth: { user: 'old', pass: 'keep-secret' } },
      groups: { '100': { enabled: true, reply: { prefix: '!' } } },
    }

    const next = applyConfigPatches(initial, deepNode, [
      { kind: 'set', path: ['smtp', 'auth', 'user'], raw: 'bot@example.com' },
      { kind: 'set', path: ['smtp'], raw: '{port:465,auth:{user:"bot2@example.com"}}' },
      { kind: 'set', path: ['groups', '200', 'reply', 'prefix'], raw: '[BOT]' },
      { kind: 'merge', value: { groups: { '100': { enabled: false } } } },
    ])

    expect(next).toEqual({
      smtp: { host: 'smtp.example.com', port: 465, auth: { user: 'bot2@example.com', pass: 'keep-secret' } },
      groups: {
        '100': { enabled: false, reply: { prefix: '!' } },
        '200': { reply: { prefix: '[BOT]' } },
      },
    })

    expect(() => applyConfigPatches({}, deepNode, [{ kind: 'merge', value: { smtp: { auth: { usr: 'x' } } } }]))
      .toThrow(/没有配置项「smtp\.auth\.usr」.*user（用户名）/)
    expect(() => applyConfigPatches(initial, deepNode, [{ kind: 'set', path: ['smtp'], raw: '{bad:1}' }]))
      .toThrow(/没有配置项「smtp\.bad」/)
  })

  it('supports tagged union objects inside arrays for creation, partial merge and branch switching', () => {
    const TaggedSchema = Schema.object({
      connect: Schema.array(Schema.union([
        Schema.object({
          type: Schema.const('ws').required(),
          port: Schema.natural().default(3001),
          token: Schema.string().default(''),
        }).description('WebSocket 正向'),
        Schema.object({
          type: Schema.const('ws-reverse').required(),
          url: Schema.string().default(''),
          token: Schema.string().default(''),
        }).description('WebSocket 反向'),
      ])).default([]),
    })
    const taggedNode = schemaOf(TaggedSchema)

    const created = applyConfigPatches({ connect: [] }, taggedNode, [
      { kind: 'set', path: ['connect', '0', 'type'], raw: 'ws-reverse' },
      { kind: 'set', path: ['connect', '0', 'url'], raw: 'ws://127.0.0.1:8080/onebot' },
    ])
    expect(created).toEqual({
      connect: [{ type: 'ws-reverse', url: 'ws://127.0.0.1:8080/onebot' }],
    })

    const patched = applyConfigPatches(
      { connect: [{ type: 'ws', port: 3001, token: 'keep-me' }] },
      taggedNode,
      [{ kind: 'set', path: ['connect', '0'], raw: '{port:3002}' }],
    )
    expect(patched).toEqual({
      connect: [{ type: 'ws', port: 3002, token: 'keep-me' }],
    })

    const switched = applyConfigPatches(
      { connect: [{ type: 'ws', port: 3001, token: 'keep-me' }] },
      taggedNode,
      [{ kind: 'set', path: ['connect', '0', 'type'], raw: 'ws-reverse' }],
    )
    expect((switched.connect as Record<string, unknown>[])[0].type).toBe('ws-reverse')

    expect(() => applyConfigPatches({ connect: [] }, taggedNode, [
      { kind: 'set', path: ['connect', '0', 'type'], raw: 'invalid' },
    ])).toThrow(/可选值为 ws \/ ws-reverse/)

    expect(() => applyConfigPatches({ connect: [{ type: 'ws-reverse', url: '' }] }, taggedNode, [
      { kind: 'set', path: ['connect', '0', 'port'], raw: '3001' },
    ])).toThrow(/没有配置项「connect\.0\.port」/)

    expect(() => applyConfigPatches({ connect: [] }, taggedNode, [
      { kind: 'merge', value: { connect: [{ type: 'ws-reverse', urll: 'ws://x' }] } },
    ])).toThrow(/没有配置项「connect\.0\.urll」/)
  })
})
