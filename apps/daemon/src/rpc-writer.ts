import { isNotificationFrame, type NotificationFrame } from "./notification-message.js"
import { isResponseFrame, type ResponseFrame } from "./response-message.js"
import {
  RpcOutboundBackpressure,
  type RpcOutboundBackpressureOptions,
  type RpcOutboundSocket,
} from "./rpc-outbound.js"

// The daemon's only way to write to an RPC client. A response reaches the wire
// only as a frame responseMessage or errorResponseMessage built, so its envelope,
// its result or error data, and every field in it were checked against the
// protocol. A notification reaches the wire only as a frame notificationMessage
// built, so its payload was checked against notificationMethods, the map the
// wire record fingerprints. The string-level writer is not reachable past here.
export class RpcWriter {
  readonly #outbound: RpcOutboundBackpressure

  constructor(options?: RpcOutboundBackpressureOptions) {
    this.#outbound = new RpcOutboundBackpressure(options)
  }

  respond(socket: RpcOutboundSocket, frame: ResponseFrame): boolean {
    if (!isResponseFrame(frame)) {
      throw new TypeError("A response frame must come from responseMessage or errorResponseMessage.")
    }
    return this.#outbound.send(socket, frame.text)
  }

  notify(socket: RpcOutboundSocket, frame: NotificationFrame, resync: () => NotificationFrame | undefined): boolean {
    if (!isNotificationFrame(frame)) {
      throw new TypeError("A notification frame must come from notificationMessage.")
    }
    return this.#outbound.notify(socket, frame.method, frame.text, () => {
      const next = resync()
      return next !== undefined && isNotificationFrame(next) ? next.text : undefined
    })
  }

  forget(socket: RpcOutboundSocket): void {
    this.#outbound.forget(socket)
  }

  dispose(): void {
    this.#outbound.dispose()
  }
}
