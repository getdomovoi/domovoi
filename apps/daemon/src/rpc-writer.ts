import { isNotificationFrame, type NotificationFrame } from "./notification-message.js"
import {
  RpcOutboundBackpressure,
  type RpcOutboundBackpressureOptions,
  type RpcOutboundSocket,
} from "./rpc-outbound.js"

// The daemon's only way to write to an RPC client. A response carries an id and
// no method. A notification reaches the wire only as a frame notificationMessage
// built, so its payload was checked against notificationMethods, the map the
// wire record fingerprints. The string-level writer is not reachable past here.
export class RpcWriter {
  readonly #outbound: RpcOutboundBackpressure

  constructor(options?: RpcOutboundBackpressureOptions) {
    this.#outbound = new RpcOutboundBackpressure(options)
  }

  // The envelope is serialized once and read back, and the check runs on what
  // was read back: toJSON can make the text differ from the object passed in.
  respond(socket: RpcOutboundSocket, payload: unknown): boolean {
    const text: string | undefined = JSON.stringify(payload)
    const envelope: unknown = text === undefined ? undefined : JSON.parse(text)
    const isObject = typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)
    if (text === undefined || !isObject || !Object.hasOwn(envelope, "id") || Object.hasOwn(envelope, "method")) {
      const method = isObject && Object.hasOwn(envelope, "method") ? String((envelope as { method: unknown }).method) : "none"
      throw new TypeError(`Only a JSON-RPC response is written here, not a message with method ${method}. A notification goes through notificationMessage.`)
    }
    return this.#outbound.send(socket, text)
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
