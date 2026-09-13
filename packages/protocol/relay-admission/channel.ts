import { x25519 } from "@noble/curves/ed25519.js"

import { createNoiseIk } from "../relay/index.js"
import {
  maximumRelayAdmissionBytes, maximumRelayBufferedBytes, maximumRelayChunkBytes,
  maximumRelayFrameBytes, maximumRelayMessageBytes, relayAdmissionContextSchema,
  relayAdmissionResultSchema, relayAdmissionTimeoutMs, relayBytes32Schema,
  relayCredentialFrameSchema, relayMessageTimeoutMs, relayRecordHeaderBytes,
  type RelayAdmissionContext,
} from "../src/relay-admission.js"

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const empty = new Uint8Array()
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const rejected = () => new Error("Relay admission rejected")

function privateKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw rejected()
  return new Uint8Array(key)
}

function encodeKey(bytes: Uint8Array): string {
  let bits = 0, value = 0, result = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 6) { bits -= 6; result += alphabet[(value >>> bits) & 63] }
  }
  if (bits > 0) result += alphabet[(value << (6 - bits)) & 63]
  return result
}

function decodeKey(text: string): Uint8Array {
  relayBytes32Schema.parse(text)
  const bytes = new Uint8Array(32)
  let bits = 0, value = 0, offset = 0
  for (const character of text) {
    value = (value << 6) | alphabet.indexOf(character)
    bits += 6
    if (bits >= 8) { bits -= 8; bytes[offset++] = (value >>> bits) & 255 }
  }
  return bytes
}

export function relayPublicKeyFromPrivateKey(key: Uint8Array): string {
  const copy = privateKey(key)
  try { return encodeKey(x25519.getPublicKey(copy)) } finally { copy.fill(0) }
}

function prologue(context: RelayAdmissionContext): Uint8Array {
  const domain = encoder.encode("domovoi.relay.admission.v1\0")
  const result = new Uint8Array(domain.length + 32)
  result.set(domain)
  result.set(decodeKey(context.routeId), domain.length)
  return result
}

export type RelayCarrier = {
  readonly bufferedAmount: number
  send(frame: Uint8Array): void
  // No daemon error text, close reason or credential is exposed to the carrier.
  close(): void
}

type Options = {
  context: RelayAdmissionContext
  staticPrivateKey: Uint8Array
  carrier: RelayCarrier
  onMessage(message: string): void
  onAdmitted?(): void
}
export type RelayClientOptions = Options & { token: string }
export type RelayResponderOptions = Options & {
  // Must be a fresh check of the same active record on every call, not a
  // memoized handshake verdict. The key is the codec's authenticated peer key.
  authorize(token: string, remoteStaticKey: Uint8Array): boolean
}

export interface RelayChannel {
  readonly admitted: boolean
  readonly closed: boolean
  receive(frame: Uint8Array): void
  send(message: string): void
  close(): void
}
export interface RelayClient extends RelayChannel { start(): void }

type Stage = "new" | "handshake" | "credential" | "receipt" | "open" | "closed"

class Channel implements RelayClient {
  #noise: ReturnType<typeof createNoiseIk> | undefined
  #stage: Stage
  #token = ""
  #peerKey: Uint8Array | undefined
  #authorize: RelayResponderOptions["authorize"] | undefined
  #options: Pick<Options, "carrier" | "onMessage" | "onAdmitted">
  #admissionTimer: ReturnType<typeof setTimeout> | undefined
  #messageTimer: ReturnType<typeof setTimeout> | undefined
  #incoming: Uint8Array | undefined
  #offset = 0
  #sending = false

  constructor(role: "initiator" | "responder", options: RelayClientOptions | RelayResponderOptions) {
    const context = relayAdmissionContextSchema.parse(options.context)
    const key = privateKey(options.staticPrivateKey)
    const ephemeral = new Uint8Array(32)
    try {
      // No Math.random or entropy fallback. Missing platform CSPRNG refuses.
      globalThis.crypto.getRandomValues(ephemeral)
      if (role === "responder" && relayPublicKeyFromPrivateKey(key) !== context.channel.responderPublicKey) throw rejected()
      this.#noise = createNoiseIk({ role, suite: context.channel.suite, staticKey: key, ephemeralKey: ephemeral,
        prologue: prologue(context),
        ...(role === "initiator" ? { responderPublicKey: decodeKey(context.channel.responderPublicKey) } : {}) })
      if (role === "initiator") this.#token = relayCredentialFrameSchema.parse({ kind: "credential", token: (options as RelayClientOptions).token }).token
      else {
        this.#authorize = (options as RelayResponderOptions).authorize
        if (typeof this.#authorize !== "function") throw rejected()
      }
    } finally { key.fill(0); ephemeral.fill(0) }
    this.#stage = role === "initiator" ? "new" : "handshake"
    this.#options = { carrier: options.carrier, onMessage: options.onMessage,
      ...(options.onAdmitted === undefined ? {} : { onAdmitted: options.onAdmitted }) }
    this.#admissionTimer = setTimeout(() => this.close(), relayAdmissionTimeoutMs)
  }

  get admitted(): boolean { return this.#stage === "open" }
  get closed(): boolean { return this.#stage === "closed" }

  #guard(operation: () => void): void {
    if (this.closed) throw rejected()
    try { operation() } catch { this.close(); throw rejected() }
  }

  #emit(frame: Uint8Array): void {
    const queued = this.#options.carrier.bufferedAmount
    if (!Number.isSafeInteger(queued) || queued < 0 || queued + frame.length > maximumRelayBufferedBytes) throw rejected()
    this.#options.carrier.send(frame)
  }

  #active(): void {
    if (this.#authorize && this.#authorize(this.#token, this.#peerKey!.slice()) !== true) throw rejected()
  }

  #open(): void {
    clearTimeout(this.#admissionTimer)
    this.#admissionTimer = undefined
    this.#stage = "open"
  }

  start(): void {
    this.#guard(() => {
      if (this.#stage !== "new") throw rejected()
      this.#stage = "handshake"
      this.#emit(this.#noise!.writeHandshake(empty))
    })
  }

  receive(frame: Uint8Array): void {
    this.#guard(() => {
      if (!(frame instanceof Uint8Array) || frame.length > maximumRelayFrameBytes || frame.length < 16) throw rejected()
      const noise = this.#noise!
      if (this.#stage === "handshake") {
        const responder = this.#authorize !== undefined
        if (frame.length !== (responder ? 96 : 48) || noise.readHandshake(frame).length !== 0) throw rejected()
        if (responder) {
          const reply = noise.writeHandshake(empty)
          this.#peerKey = noise.remoteStaticKey()
          this.#stage = "credential"
          this.#emit(reply)
        } else {
          this.#stage = "receipt"
          const payload = encoder.encode(JSON.stringify({ kind: "credential", token: this.#token }))
          this.#token = ""
          this.#emit(noise.encrypt(this.#control(0, payload)))
        }
        return
      }
      if (this.#stage === "credential" || this.#stage === "receipt") {
        if (frame.length > maximumRelayAdmissionBytes + 16) throw rejected()
        const payload = noise.decrypt(frame)
        if (this.#stage === "credential") {
          const result = relayCredentialFrameSchema.parse(this.#readControl(0, payload))
          this.#token = result.token
          this.#active()
          this.#open()
          this.#emit(noise.encrypt(this.#control(1, encoder.encode(JSON.stringify({ kind: "admitted" })))))
        } else {
          relayAdmissionResultSchema.parse(this.#readControl(1, payload))
          this.#open()
        }
        this.#options.onAdmitted?.()
        return
      }
      if (this.#stage !== "open") throw rejected()
      this.#active()
      this.#fragment(noise.decrypt(frame))
    })
  }

  #control(kind: number, payload: Uint8Array): Uint8Array {
    const record = new Uint8Array(payload.length + 1)
    record[0] = kind
    record.set(payload, 1)
    return record
  }

  #readControl(kind: number, payload: Uint8Array): unknown {
    if (payload[0] !== kind) throw rejected()
    return JSON.parse(decoder.decode(payload.subarray(1))) as unknown
  }

  #fragment(record: Uint8Array): void {
    if (record.length < relayRecordHeaderBytes || record[0] !== 2) throw rejected()
    const header = new DataView(record.buffer, record.byteOffset, record.byteLength)
    const total = header.getUint32(1, true), offset = header.getUint32(5, true)
    const payload = record.subarray(relayRecordHeaderBytes)
    if (total > maximumRelayMessageBytes || offset !== this.#offset || offset > total
      || payload.length !== Math.min(maximumRelayChunkBytes, total - offset)) throw rejected()
    if (this.#incoming && this.#incoming.length !== total) throw rejected()
    if (!this.#incoming) {
      this.#incoming = new Uint8Array(total)
      this.#messageTimer = setTimeout(() => this.close(), relayMessageTimeoutMs)
    }
    this.#incoming.set(payload, offset)
    this.#offset += payload.length
    if (this.#offset !== total) return
    const message = decoder.decode(this.#incoming)
    this.#incoming = undefined
    this.#offset = 0
    clearTimeout(this.#messageTimer)
    this.#messageTimer = undefined
    this.#options.onMessage(message)
  }

  send(message: string): void {
    this.#guard(() => {
      if (this.#stage !== "open" || this.#sending || typeof message !== "string" || message.length > maximumRelayMessageBytes) throw rejected()
      this.#active()
      const bytes = encoder.encode(message)
      if (bytes.length > maximumRelayMessageBytes) throw rejected()
      this.#sending = true
      try {
        let offset = 0
        do {
          const end = Math.min(bytes.length, offset + maximumRelayChunkBytes)
          const record = new Uint8Array(relayRecordHeaderBytes + end - offset)
          const header = new DataView(record.buffer)
          record[0] = 2
          header.setUint32(1, bytes.length, true)
          header.setUint32(5, offset, true)
          record.set(bytes.subarray(offset, end), relayRecordHeaderBytes)
          this.#emit(this.#noise!.encrypt(record))
          offset = end
        } while (offset < bytes.length)
      } finally { this.#sending = false }
    })
  }

  close(): void {
    if (this.closed) return
    this.#stage = "closed"
    clearTimeout(this.#admissionTimer)
    clearTimeout(this.#messageTimer)
    this.#incoming?.fill(0)
    this.#incoming = undefined
    this.#peerKey = undefined
    this.#token = ""
    this.#noise = undefined
    // Carrier cleanup cannot restore admission or expose its failure reason.
    try { this.#options.carrier.close() } catch { /* Already terminal. */ }
  }
}

function createChannel(role: "initiator" | "responder", options: RelayClientOptions | RelayResponderOptions): RelayClient {
  try { return new Channel(role, options) } catch {
    try { options.carrier.close() } catch { /* Refusal cannot expose cleanup errors. */ }
    throw rejected()
  }
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  return createChannel("initiator", options)
}

export function createRelayResponder(options: RelayResponderOptions): RelayChannel {
  return createChannel("responder", options)
}
