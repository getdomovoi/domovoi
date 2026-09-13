import { createRelayResponder, type RelayChannel, type RelayResponderOptions } from "@getdomovoi/protocol/relay-admission"
import type { RpcOutboundSocket } from "./rpc-outbound.js"

export const maximumDaemonRelayChannels = 32

// A logical encrypted channel, not a second HTTP listener or relay server.
// The dispatcher sees the same bounded message/socket contract as direct RPC.
export class DaemonRelaySocket implements RpcOutboundSocket {
  readonly #channel: RelayChannel
  readonly #carrier: RelayResponderOptions["carrier"]

  constructor(options: RelayResponderOptions & { onClose(): void }) {
    this.#carrier = options.carrier
    this.#channel = createRelayResponder({ ...options, carrier: {
      get bufferedAmount() { return options.carrier.bufferedAmount },
      send: (frame) => options.carrier.send(frame),
      close: () => { try { options.carrier.close() } finally { options.onClose() } },
    } })
  }

  get readyState(): number { return this.#channel.closed ? 3 : 1 }
  get bufferedAmount(): number { return this.#carrier.bufferedAmount }
  get closed(): boolean { return this.#channel.closed }

  receive(frame: Uint8Array): void {
    try { this.#channel.receive(frame) } catch { /* The channel already closed uniformly. */ }
  }

  send(message: string): void {
    try { this.#channel.send(message) } catch { /* No plaintext failure goes to the carrier. */ }
  }

  close(): void { this.#channel.close() }
}
