import { randomUUID } from 'node:crypto'
import type { InstanceMessage, ManagerMessage, PackageRpcAction } from './protocol'

export interface PackageCoordinatorOptions {
  /** Delivers an IPC message to the named managed instance; false if it is no longer connected */
  send(instance: string, message: ManagerMessage): boolean
  /** Current OS PID of the named instance, used only for error reporting */
  pidOf?(instance: string): number | undefined
  /** Per-peer RPC timeout in ms (default 30s, matching SharedPackages) */
  timeoutMs?: number
}

interface RegisteredPeer {
  instance: string
  peerId: string
  roots: Set<string>
}

interface PendingRpc {
  target: string
  timer: NodeJS.Timeout
  resolve(value: unknown): void
  reject(error: Error): void
}

const DEFAULT_TIMEOUT = 30_000

/**
 * Coordinates shared plugin directory changes across all managed child instances directly over Node IPC,
 * replacing tmp peer files and loopback TCP discovery for managed processes.
 */
export class PackageCoordinator {
  private readonly peers = new Map<string, RegisteredPeer>()
  private readonly pending = new Map<string, PendingRpc>()
  private readonly timeoutMs: number

  constructor(private readonly options: PackageCoordinatorOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
  }

  onMessage(instance: string, message: InstanceMessage): void {
    switch (message.type) {
      case 'pkg:register':
        this.peers.set(instance, {
          instance,
          peerId: message.id,
          roots: new Set(message.roots),
        })
        return
      case 'pkg:unregister': {
        const current = this.peers.get(instance)
        if (current && current.peerId === message.id) {
          this.peers.delete(instance)
          this.failPendingFor(instance, `${instance} 已注销插件协调`)
        }
        return
      }
      case 'pkg:rpc-result': {
        const call = this.pending.get(message.reqId)
        if (!call) return
        this.pending.delete(message.reqId)
        clearTimeout(call.timer)
        if (message.error !== undefined) call.reject(new Error(message.error))
        else call.resolve(message.value)
        return
      }
      case 'pkg:broadcast':
        void this.broadcast(instance, message)
        return
    }
  }

  /** Called when a managed child process exits or disconnects */
  onExit(instance: string): void {
    this.peers.delete(instance)
    this.failPendingFor(instance, `${instance} 在插件协调期间断开连接`)
  }

  /** Snapshot of registered peer instances sharing a canonical root (for diagnostics/tests) */
  registeredFor(root: string): string[] {
    return [...this.peers.values()].filter(peer => peer.roots.has(root)).map(peer => peer.instance)
  }

  private async broadcast(
    sender: string,
    message: Extract<InstanceMessage, { type: 'pkg:broadcast' }>,
  ): Promise<void> {
    const targets = [...this.peers.values()].filter(
      peer => peer.instance !== sender && peer.peerId !== message.senderId && peer.roots.has(message.root),
    )

    if (targets.length === 0) {
      this.options.send(sender, { type: 'pkg:broadcast-result', reqId: message.reqId, results: [] })
      return
    }

    if (message.action === 'prepare') {
      const settled = await Promise.allSettled(
        targets.map(target => this.call(target.instance, 'prepare', message.change)),
      )
      const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) {
        this.options.send(sender, {
          type: 'pkg:broadcast-result',
          reqId: message.reqId,
          error: failed.reason instanceof Error ? failed.reason.message : String(failed.reason),
        })
      } else {
        this.options.send(sender, { type: 'pkg:broadcast-result', reqId: message.reqId, results: [] })
      }
      return
    }

    // action === 'finish'
    const results = await Promise.all(targets.map(async (target) => {
      try {
        return await this.call(target.instance, 'finish', message.change, message.applied)
      } catch (error) {
        return {
          instance: target.instance,
          pid: this.options.pidOf?.(target.instance) ?? 0,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    }))
    this.options.send(sender, { type: 'pkg:broadcast-result', reqId: message.reqId, results })
  }

  private call(target: string, action: PackageRpcAction, change: Record<string, unknown>, applied?: boolean): Promise<unknown> {
    const reqId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        reject(new Error(`${target} 未响应插件协调请求`))
      }, this.timeoutMs)
      timer.unref?.()

      this.pending.set(reqId, { target, timer, resolve, reject })
      const sent = this.options.send(target, { type: 'pkg:rpc', reqId, action, change, applied })
      if (!sent) {
        this.pending.delete(reqId)
        clearTimeout(timer)
        reject(new Error(`${target} 在插件协调期间断开连接`))
      }
    })
  }

  private failPendingFor(instance: string, reason: string): void {
    for (const [reqId, call] of this.pending) {
      if (call.target !== instance) continue
      this.pending.delete(reqId)
      clearTimeout(call.timer)
      call.reject(new Error(reason))
    }
  }
}
