import { BaseAction, Schema } from '../../BaseAction'
import { ActionName } from '../../types'

interface Payload {
  cmd: string
  hex: string
}
interface PBData {
  cmd: string
  hex: string
  echo?: string
}

export class SendPB extends BaseAction<Payload, PBData> {
  actionName = ActionName.SendPB
  payloadSchema = Schema.object({
    cmd: Schema.string().required(),
    hex: Schema.string().required()
  })

  async _handle(payload: Payload) {
    try {
      const result = await this.ctx.qqProtocol.sendPB(payload.cmd, payload.hex)
      return {
        cmd: result.cmd,
        hex: result.pb,
        ...(result.echo !== undefined ? { echo: result.echo } : {})
      }
    }
    catch (e) {
      // 直连和 PMHQ 两种模式共用这个 action, 文案不能写死 pmhq (直连模式根本不经过 pmhq).
      this.ctx.logger.error('send_pb 发包失败', e)
      throw new Error(`send_pb 发包失败: ${e}`, { cause: e })
    }
  }
}
