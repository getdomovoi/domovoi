import {
  credentialSchema, encodeRelayCarrierControl, machineIdSchema, maximumRelayBufferedBytes,
  maximumRelayCarrierControlBytes, maximumRelayFrameBytes, parseRelayCarrierControl,
  relayBytes32Schema, relayClientPinSchema, transportCandidateSchema,
  type RelayCarrierControl, type RelayClientPin,
} from "@getdomovoi/protocol"
import type { RelayClient, RelayPinStore } from "@getdomovoi/protocol/relay-admission"

import { ClientAdmissionError } from "./client-admission-policy.js"
import type { ClientSocket } from "./client-socket.js"
import type { Deadline } from "./deadline.js"

export type RelayWebSocket = Pick<WebSocket, "readyState" | "bufferedAmount" | "binaryType" | "send" | "close" | "addEventListener" | "removeEventListener">
export type RelaySocketOptions = {
  endpoint: string
  machineId: string
  routeId: string
  token: string
  // The key enrolled with this paired device, never a bearer-derived key or
  // newly generated static identity. Noise generates a fresh ephemeral itself.
  staticPrivateKey: Uint8Array
  pinStore: RelayPinStore
  deadline: Deadline
  limits: { windowMs: number; maximumMessagesPerWindow: number; maximumBytesPerWindow: number }
  now?: () => number
  createWebSocket?: (url: string) => RelayWebSocket
}

const encoder = new TextEncoder(), decoder = new TextDecoder()
const refused = () => new ClientAdmissionError("relay-verification-refused")
type Stage = "starting" | "recovering" | "verifying" | "connecting" | "admitting" | "open" | "closed"

// One attempt owns two sequential physical sockets and one fresh Noise channel.
// It never queues application messages or reconnects. The client owns retry,
// state refresh and pending-RPC failure after this attempt closes.
class RelaySocket implements ClientSocket {
  readonly #events = new EventTarget()
  #stage: Stage = "starting"
  #localRefusal: "relay-verification-refused" | undefined
  #wire: RelayWebSocket | undefined
  #wireListeners: AbortController | undefined
  #channel: RelayClient | undefined
  #key: Uint8Array
  #token: string
  readonly #endpoint: string
  readonly #machineId: string
  readonly #routeId: string
  readonly #store: RelayPinStore
  readonly #deadline: Deadline
  readonly #factory: (url: string) => RelayWebSocket
  readonly #limits: RelaySocketOptions["limits"]
  readonly #now: () => number
  #lastAt: number | undefined
  #windowAt = 0
  #messages = 0
  #bytes = 0
  readonly #expire = () => this.#finish(1006)

  constructor(options: RelaySocketOptions) {
    this.#endpoint = options.endpoint
    this.#machineId = options.machineId
    this.#routeId = options.routeId
    this.#token = options.token
    this.#key = options.staticPrivateKey instanceof Uint8Array && options.staticPrivateKey.length === 32
      ? new Uint8Array(options.staticPrivateKey) : new Uint8Array()
    this.#store = options.pinStore
    this.#deadline = options.deadline
    this.#factory = options.createWebSocket ?? ((url) => new WebSocket(url))
    this.#limits = { ...options.limits }
    this.#now = options.now ?? (() => performance.now())
    // Defer all observable work until the consumer can attach its listeners.
    void Promise.resolve().then(() => this.#begin()).catch(() => this.#refuse())
  }

  get localAdmissionRefusal(): "relay-verification-refused" | undefined { return this.#localRefusal }

  get readyState(): number { return this.#stage === "closed" ? 3 : this.#stage === "open" ? 1 : 0 }

  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void, options?: AddEventListenerOptions): void {
    this.#events.addEventListener(type, listener as EventListener, options)
  }

  send(message: string): void {
    if (this.#stage !== "open") throw refused()
    try { this.#channel!.send(message) } catch { this.#refuse(); throw refused() }
  }

  close(): void { this.#finish(1000) }

  #alive(): boolean {
    if (this.#stage === "closed") return false
    if (this.#stage !== "open" && this.#deadline.remainingMs() <= 0) { this.#finish(1006); return false }
    return true
  }

  #dropWire(): void {
    this.#wireListeners?.abort()
    this.#wireListeners = undefined
    const wire = this.#wire
    this.#wire = undefined
    try { wire?.close(1000, "client closed") } catch { /* Refusal cannot revive an abandoned socket. */ }
  }

  #refuse(): void { this.#finish(1008, true) }

  #finish(code: number, localRefusal = false): void {
    if (this.#stage === "closed") return
    // First terminal outcome wins. A later local exception cannot upgrade an
    // earlier network/peer closure into a locally verified refusal.
    if (localRefusal) this.#localRefusal = "relay-verification-refused"
    this.#stage = "closed"
    this.#deadline.signal.removeEventListener("abort", this.#expire)
    this.#key.fill(0)
    this.#token = ""
    this.#dropWire()
    this.#channel?.close()
    this.#channel = undefined
    // Browser WebSocket.close cannot send 1008, but the local facade must
    // preserve a terminal policy refusal for DomovoiClient's retry boundary.
    this.#events.dispatchEvent(Object.assign(new Event("close"), { code, reason: "", wasClean: code === 1000 }))
  }

  #boundedSend(data: string | Uint8Array): void {
    const wire = this.#wire
    const bytes = typeof data === "string" ? encoder.encode(data).byteLength : data.byteLength
    if (!this.#alive()) throw refused()
    if (!wire || wire.readyState !== 1) { this.#finish(1006); throw refused() }
    if (!Number.isSafeInteger(wire.bufferedAmount) || wire.bufferedAmount < 0
      || wire.bufferedAmount + bytes > maximumRelayBufferedBytes) { this.#refuse(); throw refused() }
    try { wire.send(typeof data === "string" ? data : new Uint8Array(data)) }
    catch { this.#finish(1006); throw refused() }
  }

  #charge(bytes: number): void {
    const at = this.#now()
    if (!Number.isFinite(at) || at < 0 || (this.#lastAt !== undefined && at < this.#lastAt)) throw refused()
    this.#lastAt = at
    if (at - this.#windowAt >= this.#limits.windowMs) {
      this.#windowAt = at
      this.#messages = 0
      this.#bytes = 0
    }
    if (this.#messages >= this.#limits.maximumMessagesPerWindow
      || bytes > this.#limits.maximumBytesPerWindow - this.#bytes) throw refused()
    this.#messages++
    this.#bytes += bytes
  }

  #openWire(greeting: RelayCarrierControl): void {
    if (!this.#alive()) return
    const wire = this.#factory(this.#endpoint)
    if (!this.#alive()) { wire.close(); return }
    this.#wire = wire
    wire.binaryType = "arraybuffer"
    const listeners = new AbortController()
    this.#wireListeners = listeners
    const current = () => this.#wire === wire && this.#alive()
    wire.addEventListener("open", () => {
      if (!current()) return
      try { this.#boundedSend(decoder.decode(encodeRelayCarrierControl(greeting))) }
      catch { this.#finish(1006) }
    }, { once: true, signal: listeners.signal })
    wire.addEventListener("message", (event) => {
      if (!current()) return
      try { this.#receive(event.data) } catch { this.#refuse() }
    }, { signal: listeners.signal })
    wire.addEventListener("close", (event) => {
      if (current()) this.#finish(event.code === 1008 ? 1008 : 1006)
    }, { once: true, signal: listeners.signal })
    wire.addEventListener("error", () => {
      if (current()) this.#finish(1006)
    }, { once: true, signal: listeners.signal })
  }

  async #begin(): Promise<void> {
    if (!this.#alive()) return
    transportCandidateSchema.parse({ kind: "relay", endpoint: this.#endpoint, authenticated: true })
    machineIdSchema.parse(this.#machineId)
    relayBytes32Schema.parse(this.#routeId)
    credentialSchema.parse(this.#token)
    if (this.#key.length !== 32) throw refused()
    if (![this.#limits.windowMs, this.#limits.maximumMessagesPerWindow, this.#limits.maximumBytesPerWindow]
      .every((value) => Number.isSafeInteger(value) && value > 0) || this.#limits.windowMs > 2_147_483_647) throw refused()
    this.#windowAt = this.#now()
    if (!Number.isFinite(this.#windowAt) || this.#windowAt < 0) throw refused()
    this.#lastAt = this.#windowAt
    this.#deadline.signal.addEventListener("abort", this.#expire, { once: true })
    const { relayIdentityPublicKeyIsValid } = await import("@getdomovoi/protocol/relay-admission")
    if (!this.#alive()) return
    const pin = relayClientPinSchema.parse(await this.#store.read())
    if (!this.#alive()) return
    if (pin.identity.machineId !== this.#machineId || !relayIdentityPublicKeyIsValid(pin.identity.identityPublicKey)) throw refused()
    this.#stage = "recovering"
    this.#openWire({ kind: "recover", carrierVersion: 1, routeId: this.#routeId, machineId: this.#machineId })
  }

  #receive(data: unknown): void {
    if (this.#stage === "recovering" || this.#stage === "connecting") {
      // The browser allocates a WebSocket message before this callback. These
      // checks bound decoding/parsing, not the browser's network allocation.
      if (typeof data !== "string" || data.length > maximumRelayCarrierControlBytes) throw refused()
      const bytes = encoder.encode(data)
      this.#charge(bytes.byteLength)
      const control = parseRelayCarrierControl(bytes)
      if (this.#stage === "recovering" && control.kind === "recovery") {
        this.#stage = "verifying"
        this.#dropWire()
        void this.#recover(control.recovery).catch(() => this.#refuse())
      } else if (this.#stage === "connecting" && control.kind === "connected") {
        this.#stage = "admitting"
        this.#channel!.start()
      } else throw refused()
      return
    }
    if ((this.#stage !== "admitting" && this.#stage !== "open") || !(data instanceof ArrayBuffer)
      || data.byteLength === 0 || data.byteLength > maximumRelayFrameBytes) throw refused()
    this.#charge(data.byteLength)
    // Clients carry bare encrypted frames. Only the daemon publisher uses the
    // carrier's four-byte multiplex header.
    this.#channel!.receive(new Uint8Array(data))
  }

  async #recover(publication: Extract<RelayCarrierControl, { kind: "recovery" }>["recovery"]): Promise<void> {
    const { adoptRelayRecovery, createPinnedRelayClient } = await import("@getdomovoi/protocol/relay-admission")
    if (!this.#alive()) return
    // Every storage boundary checks ownership again. A CAS already in progress
    // may durably adopt a valid successor after close; it cannot open a socket.
    const store: RelayPinStore = {
      read: async () => {
        if (!this.#alive()) throw refused()
        const value = await this.#store.read()
        if (!this.#alive()) throw refused()
        const pin = relayClientPinSchema.parse(value)
        if (pin.identity.machineId !== this.#machineId) throw refused()
        return pin
      },
      compareAndSwap: async (expected: RelayClientPin, replacement: RelayClientPin) => {
        if (!this.#alive()) throw refused()
        const saved = await this.#store.compareAndSwap(expected, replacement)
        if (!this.#alive()) throw refused()
        return saved === true
      },
    }
    const current = relayClientPinSchema.parse(await store.read())
    if (publication.identity.machineId !== this.#machineId) throw refused()
    if (current.state !== "trusted" || JSON.stringify(current.identity) !== JSON.stringify(publication.identity)) {
      await adoptRelayRecovery(store, publication)
    }
    if (!this.#alive()) return
    const channel = await createPinnedRelayClient(store, { machineId: this.#machineId, routeId: this.#routeId,
      token: this.#token, staticPrivateKey: this.#key,
      carrier: {
        get bufferedAmount() { return 0 },
        send: (frame) => this.#boundedSend(frame),
        // Construction failures (including missing entropy) are terminal.
        // Later the channel also closes on its own deadline. Synchronous
        // crypto/parse failures latch 1008 before that deferred timer-style loss.
        close: () => {
          if (this.#stage === "verifying") this.#refuse()
          else queueMicrotask(() => this.#finish(1006))
        },
      },
      onAdmitted: () => {
        if (!this.#alive()) return
        this.#stage = "open"
        this.#deadline.signal.removeEventListener("abort", this.#expire)
        this.#events.dispatchEvent(new Event("open"))
      },
      onMessage: (message) => {
        if (this.#stage === "open") this.#events.dispatchEvent(new MessageEvent("message", { data: message }))
      },
    })
    this.#key.fill(0)
    this.#token = ""
    if (!this.#alive()) { channel.close(); return }
    this.#channel = channel
    this.#stage = "connecting"
    this.#openWire({ kind: "connect", carrierVersion: 1, routeId: this.#routeId })
  }
}

export function createRelaySocket(options: RelaySocketOptions): ClientSocket { return new RelaySocket(options) }
