import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PackageCoordinator } from '@/main/manager/packageCoordinator'
import type { InstanceMessage, ManagerMessage } from '@/main/manager/protocol'
import { SharedPackages, type SharedPackageChange, type SharedPackageResult, type SharedPackagesIpc } from '@/plugin/host/shared-packages'

/** Wires a SharedPackages instance directly to a PackageCoordinator in memory (exact same message flow as Node IPC) */
function createBridge(coordinator: PackageCoordinator, instance: string): { ipc: SharedPackagesIpc; deliver(msg: ManagerMessage): void } {
  let rpcHandler: ((action: 'prepare' | 'finish', change: SharedPackageChange, applied?: boolean) => Promise<unknown>) | undefined
  const waiters = new Map<string, { resolve(value: SharedPackageResult[]): void; reject(error: Error): void }>()
  let seq = 0

  const sendToManager = (message: InstanceMessage) => coordinator.onMessage(instance, message)

  const deliver = (message: ManagerMessage) => {
    if (message.type === 'pkg:broadcast-result') {
      const waiter = waiters.get(message.reqId)
      if (!waiter) return
      waiters.delete(message.reqId)
      if (message.error !== undefined) waiter.reject(new Error(message.error))
      else waiter.resolve((message.results ?? []) as SharedPackageResult[])
      return
    }
    if (message.type === 'pkg:rpc') {
      if (!rpcHandler) {
        sendToManager({ type: 'pkg:rpc-result', reqId: message.reqId, error: 'not ready' })
        return
      }
      void rpcHandler(message.action, message.change as unknown as SharedPackageChange, message.applied).then(
        value => sendToManager({ type: 'pkg:rpc-result', reqId: message.reqId, value }),
        error => sendToManager({ type: 'pkg:rpc-result', reqId: message.reqId, error: error instanceof Error ? error.message : String(error) }),
      )
    }
  }

  const ipc: SharedPackagesIpc = {
    register(id, roots) {
      sendToManager({ type: 'pkg:register', id, roots })
    },
    unregister(id) {
      sendToManager({ type: 'pkg:unregister', id })
    },
    broadcast(senderId, root, action, change, applied) {
      const reqId = `req-${++seq}`
      return new Promise<SharedPackageResult[]>((resolve, reject) => {
        waiters.set(reqId, { resolve, reject })
        sendToManager({
          type: 'pkg:broadcast',
          reqId,
          senderId,
          root,
          action,
          change: change as unknown as Record<string, unknown>,
          applied,
        })
      })
    },
    onRpc(handler) {
      rpcHandler = handler
      return () => {
        if (rpcHandler === handler) rpcHandler = undefined
      }
    },
  }

  return { ipc, deliver }
}

let dir: string
let sharedRoot: string
let otherRoot: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'llbot-pkg-ipc-'))
  sharedRoot = path.join(dir, 'plugins')
  otherRoot = path.join(dir, 'other-plugins')
  mkdirSync(sharedRoot, { recursive: true })
  mkdirSync(otherRoot, { recursive: true })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('PackageCoordinator and SharedPackages over manager IPC', () => {
  it('broadcasts prepare and finish across managed peers sharing a root without writing peer files', async () => {
    const inbox = new Map<string, (msg: ManagerMessage) => void>()
    const coordinator = new PackageCoordinator({
      send: (instance, msg) => {
        const deliver = inbox.get(instance)
        if (!deliver) return false
        queueMicrotask(() => deliver(msg))
        return true
      },
      pidOf: () => 42,
    })

    const events: string[] = []
    const makePeer = (name: string, root: string) => {
      const bridge = createBridge(coordinator, name)
      inbox.set(name, bridge.deliver)
      return new SharedPackages({
        roots: [root],
        instance: name,
        ipc: bridge.ipc,
        prepare: async (change) => { events.push(`${name}:prepare:${change.name}`) },
        finish: async (change, applied) => {
          events.push(`${name}:finish:${change.name}:${applied}`)
          return { status: 'reloaded', entries: [`${name}-entry`] }
        },
        warn: vi.fn(),
      })
    }

    const alpha = makePeer('alpha', sharedRoot)
    const beta = makePeer('beta', sharedRoot)
    const gamma = makePeer('gamma', otherRoot)

    await alpha.initialize(async () => {})
    await beta.initialize(async () => {})
    await gamma.initialize(async () => {})

    try {
      // No peer files created under .llbot-packages/peers/ in managed IPC mode
      expect(existsSync(path.join(sharedRoot, '.llbot-packages', 'peers'))).toBe(false)

      const result = await alpha.exclusive(sharedRoot, () =>
        alpha.change({ root: sharedRoot, name: 'demo-plugin', kind: 'install' }, async () => {
          events.push('apply:demo-plugin')
          return 'installed'
        }),
      )

      expect(result.value).toBe('installed')
      expect(result.instances.map(i => `${i.instance}:${i.status}`).sort()).toEqual([
        'alpha:reloaded',
        'beta:reloaded',
      ])
      // Both peers prepared BEFORE apply, and finished AFTER apply; unrelated gamma untouched
      const applyIndex = events.indexOf('apply:demo-plugin')
      expect(events.indexOf('alpha:prepare:demo-plugin')).toBeLessThan(applyIndex)
      expect(events.indexOf('beta:prepare:demo-plugin')).toBeLessThan(applyIndex)
      expect(events.indexOf('alpha:finish:demo-plugin:true')).toBeGreaterThan(applyIndex)
      expect(events.indexOf('beta:finish:demo-plugin:true')).toBeGreaterThan(applyIndex)
      expect(events.some(e => e.startsWith('gamma:'))).toBe(false)
    } finally {
      await alpha.close()
      await beta.close()
      await gamma.close()
    }
  })

  it('aborts apply and runs rollback finish(applied=false) when a peer refuses prepare', async () => {
    const inbox = new Map<string, (msg: ManagerMessage) => void>()
    const coordinator = new PackageCoordinator({
      send: (instance, msg) => {
        const deliver = inbox.get(instance)
        if (!deliver) return false
        queueMicrotask(() => deliver(msg))
        return true
      },
    })

    const finishedApplied: Array<[string, boolean]> = []
    const makePeer = (name: string, refusePrepare = false) => {
      const bridge = createBridge(coordinator, name)
      inbox.set(name, bridge.deliver)
      return new SharedPackages({
        roots: [sharedRoot],
        instance: name,
        ipc: bridge.ipc,
        prepare: async () => {
          if (refusePrepare) throw new Error(`${name} busy`)
        },
        finish: async (_change, applied) => {
          finishedApplied.push([name, applied])
          return { status: 'unchanged' }
        },
        warn: vi.fn(),
      })
    }

    const alpha = makePeer('alpha')
    const beta = makePeer('beta', true)
    await alpha.initialize(async () => {})
    await beta.initialize(async () => {})

    try {
      const apply = vi.fn(async () => 'should-not-run')
      await expect(
        alpha.exclusive(sharedRoot, () => alpha.change({ root: sharedRoot, name: 'demo', kind: 'install' }, apply)),
      ).rejects.toThrow('beta busy')
      expect(apply).not.toHaveBeenCalled()
      expect(finishedApplied.sort()).toEqual([['alpha', false], ['beta', false]])
    } finally {
      await alpha.close()
      await beta.close()
    }
  })

  it('immediately fails in-flight prepare RPCs when a peer exits unexpectedly', async () => {
    const received: ManagerMessage[] = []
    const coordinator = new PackageCoordinator({
      send: (instance, msg) => {
        if (instance === 'alpha') received.push(msg)
        return true
      },
    })

    coordinator.onMessage('alpha', { type: 'pkg:register', id: 'a', roots: ['/r'] })
    coordinator.onMessage('beta', { type: 'pkg:register', id: 'b', roots: ['/r'] })
    coordinator.onMessage('alpha', {
      type: 'pkg:broadcast',
      reqId: 'r1',
      senderId: 'a',
      root: '/r',
      action: 'prepare',
      change: { id: 'c1', root: '/r', name: 'x', kind: 'install', initiator: 'a' },
    })

    // Beta exits before replying
    coordinator.onExit('beta')
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(received).toContainEqual(expect.objectContaining({
      type: 'pkg:broadcast-result',
      reqId: 'r1',
      error: expect.stringContaining('beta'),
    }))
    expect(coordinator.registeredFor('/r')).toEqual(['alpha'])
  })
})
