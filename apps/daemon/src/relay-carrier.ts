import { createHash, randomBytes } from "node:crypto"
import { lstatSync } from "node:fs"
import { isAbsolute, join } from "node:path"

import { decodeRelayMultiplexedFrame, encodeRelayCarrierControl, encodeRelayMultiplexedFrame,
  maximumRelayMultiplexedFrameBytes, parseRelayCarrierControl, relayCarrierGreetingSchema,
  type RelayAdmissionContext, type RelayRecoveryResult } from "@getdomovoi/protocol"
import type { RelayCarrier, RelayChannel } from "@getdomovoi/protocol/relay-admission"
import { WebSocket, type ClientOptions } from "ws"
import { z } from "zod"

import { openRelayGeneration } from "./relay-generation.js"
import { readLocalProfileFile } from "./local-owner-record.js"

export type DaemonRelayCarrierOptions = {
  url: string; routeId: string; registrationCredential: string; generationPath: string; ca?: string
  policy: { connectTimeoutMs: number; registrationTimeoutMs: number; sendTimeoutMs: number; maximumAttempts: number;
    retryBaseMs: number; retryMaximumMs: number; heartbeatIntervalMs: number; heartbeatTimeoutMs: number;
    maximumChannels: number; maximumQueuedBytes: number; maximumQueuedMessages: number }
}
type Refusal = "tls" | "registration" | "protocol" | "capacity" | "generation" | "transport"
export type DaemonRelayCarrierStatus = { state: "idle" | "connecting" | "registered" | "retrying" | "stopped" }
  | { state: "refused"; reason: Refusal }
export type DaemonRelayCarrier = { start(): void; stop(): Promise<void>; readonly status: DaemonRelayCarrierStatus }
type Endpoint = { recovery: RelayRecoveryResult; onStatus?(status: DaemonRelayCarrierStatus): void
  openChannel(options: { context: RelayAdmissionContext; carrier: RelayCarrier }): Pick<RelayChannel, "receive" | "close" | "closed"> }
const bounded = (maximum: number) => z.number().int().min(1).max(maximum)
const policySchema = z.object({
  connectTimeoutMs: bounded(2_147_483_647), registrationTimeoutMs: bounded(2_147_483_647), sendTimeoutMs: bounded(2_147_483_647),
  maximumAttempts: bounded(100), retryBaseMs: bounded(2_147_483_647), retryMaximumMs: bounded(2_147_483_647),
  heartbeatIntervalMs: bounded(2_147_483_647), heartbeatTimeoutMs: bounded(2_147_483_647),
  maximumChannels: bounded(32), maximumQueuedBytes: bounded(16 * 1024 * 1024), maximumQueuedMessages: bounded(1024),
}).strict().refine((value) => value.retryMaximumMs >= value.retryBaseMs)
const configurationSchema = z.object({
  version: z.literal(1), url: z.string().min(1).max(4096), routeId: z.string().length(43), registrationCredential: z.string().length(43),
  ca: z.string().min(1).max(65536).optional(), policy: policySchema,
}).strict()

// Called by the production factory while it holds the profile lease. This is
// local operator input, not credential issuance or an account enrollment API.
export function loadDaemonRelayCarrierConfiguration(profileDirectory: string): DaemonRelayCarrierOptions | undefined {
  let text: string
  try {
    const path = join(profileDirectory, "relay-carrier.json")
    if (!lstatSync(path).isFile()) throw new Error("Relay configuration must be a regular file")
    text = readLocalProfileFile(path, 65536)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error("Relay carrier configuration must be a private bounded regular file", { cause: error })
  }
  try {
    const { version: _version, ca, ...config } = configurationSchema.parse(JSON.parse(text))
    return { ...config, ...(ca !== undefined ? { ca } : {}), generationPath: join(profileDirectory, "relay-generation.json") }
  } catch {
    throw new Error("Relay carrier configuration is invalid; inspect the private profile configuration")
  }
}
export function relayRegistrationBinding(options: Pick<DaemonRelayCarrierOptions, "url" | "routeId" | "registrationCredential">, machineId: string): string {
  return createHash("sha256").update(JSON.stringify([new URL(options.url).href, options.routeId, machineId, options.registrationCredential])).digest("hex")
}
export function createDaemonRelayCarrier(input: DaemonRelayCarrierOptions, endpoint: Endpoint): DaemonRelayCarrier {
  // No redirect, userinfo, query bearer or caller-supplied TLS verification hook.
  if (typeof input.url !== "string" || input.url.length > 4096) throw new Error("Invalid relay carrier URL")
  let url: URL
  try { url = new URL(input.url) } catch { throw new Error("Invalid relay carrier URL") }
  if (url.protocol !== "wss:" || url.username || url.password || url.hash || url.search || input.url.length > 4096
    || !isAbsolute(input.generationPath) || (input.ca !== undefined && (typeof input.ca !== "string" || input.ca.length > 65536))) throw new Error("Invalid relay carrier configuration")
  const policy = policySchema.parse(input.policy)
  const options = { ...input, url: url.href, policy }
  const recovery = structuredClone(endpoint.recovery)
  const greeting = relayCarrierGreetingSchema.safeParse({ kind: "register", carrierVersion: 1, routeId: options.routeId,
    registrationCredential: options.registrationCredential, machineId: recovery.identity.machineId, generation: 1, recovery })
  if (!greeting.success) throw new Error("Invalid relay carrier registration")
  const generations = openRelayGeneration(options.generationPath, relayRegistrationBinding(options, recovery.identity.machineId))
  let status: DaemonRelayCarrierStatus = { state: "idle" }
  let stopped = false, started = false, attempts = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  let dialing = Promise.resolve()
  let retire: (() => void) | undefined
  function report(next: DaemonRelayCarrierStatus) {
    status = next
    try { endpoint.onStatus?.({ ...next }) } catch { /* Diagnostics cannot change transport ownership. */ }
  }
  const refused = (reason: Refusal) => report({ state: "refused", reason })

  function schedule() {
    if (stopped) return
    if (attempts >= policy.maximumAttempts) { refused("transport"); return }
    report({ state: "retrying" })
    const cap = Math.min(policy.retryMaximumMs, policy.retryBaseMs * 2 ** Math.min(attempts - 1, 30))
    // Equal jitter has a positive floor and cannot create a synchronous retry loop.
    retry = setTimeout(begin, Math.max(1, Math.floor(cap * (0.5 + Math.random() / 2))))
    retry.unref()
  }
  function begin() {
    retry = undefined
    dialing = dial().catch(() => { if (!stopped) refused("generation") })
  }
  async function dial() {
    report({ state: "connecting" })
    attempts++
    const generation = await generations.next()
    if (stopped) return
    const settings: ClientOptions & { maxFragments: number; maxBufferedChunks: number } = {
      // Keep Node's default certificate and hostname verification intact.
      rejectUnauthorized: true, followRedirects: false, perMessageDeflate: false, autoPong: false,
      maxPayload: maximumRelayMultiplexedFrameBytes, maxFragments: 128, maxBufferedChunks: 128,
      ...(options.ca !== undefined ? { ca: options.ca } : {}),
    }
    let socket: WebSocket
    try { socket = new WebSocket(options.url, settings) } catch { refused("tls"); return }
    let fenced = false, opened = false, registered = false, highWater = 0
    let phaseTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => fail(undefined), policy.connectTimeoutMs)
    phaseTimer.unref()
    let sendTimer: ReturnType<typeof setTimeout> | undefined
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined
    let awaitingPong: Uint8Array | undefined
    const channels = new Map<number, ReturnType<Endpoint["openChannel"]>>()
    const queue: Array<{ bytes: Uint8Array; binary: boolean; ping: boolean }> = []
    let queuedBytes = 0, sending = false
    function fence() {
      if (fenced) return
      fenced = true
      clearTimeout(phaseTimer); clearTimeout(sendTimer); clearTimeout(heartbeatTimer)
      const previous = [...channels.values()]
      channels.clear(); queue.length = 0; queuedBytes = 0
      for (const channel of previous) channel.close()
      socket.terminate()
    }
    retire = fence
    function fail(reason: Refusal | undefined) {
      if (fenced) return
      fence()
      if (stopped) return
      if (reason) refused(reason)
      else if (opened && !registered) refused("registration")
      else schedule()
    }
    function pump() {
      const entry = queue[0]
      if (fenced || sending || !entry) return
      sending = true
      sendTimer = setTimeout(() => fail("capacity"), policy.sendTimeoutMs)
      sendTimer.unref()
      try {
        const sent = (error?: Error) => {
          if (fenced) return
          clearTimeout(sendTimer)
          if (error) { fail(undefined); return }
          queue.shift(); queuedBytes -= entry.bytes.byteLength; sending = false; pump()
        }
        if (entry.ping) socket.ping(entry.bytes, true, sent)
        else socket.send(entry.bytes, { binary: entry.binary }, sent)
      } catch { fail(undefined) }
    }
    function enqueue(bytes: Uint8Array, binary: boolean, ping = false) {
      if (fenced) return
      if (queue.length >= policy.maximumQueuedMessages || queuedBytes + bytes.byteLength > policy.maximumQueuedBytes) {
        fail("capacity"); return
      }
      queue.push({ bytes: Uint8Array.from(bytes), binary, ping }); queuedBytes += bytes.byteLength
      pump()
    }
    function heartbeat() {
      heartbeatTimer = setTimeout(() => {
        awaitingPong = randomBytes(8)
        heartbeatTimer = setTimeout(() => fail(undefined), policy.heartbeatTimeoutMs)
        heartbeatTimer.unref()
        enqueue(awaitingPong, true, true)
      }, policy.heartbeatIntervalMs)
      heartbeatTimer.unref()
    }
    function closeChannel(id: number, notify: boolean) {
      const channel = channels.get(id)
      channels.delete(id)
      channel?.close()
      if (notify && !fenced) enqueue(encodeRelayCarrierControl({ kind: "close", carrierVersion: 1, channelId: id }), false)
    }
    socket.on("open", () => {
      if (fenced) return
      opened = true
      clearTimeout(phaseTimer)
      phaseTimer = setTimeout(() => fail("registration"), policy.registrationTimeoutMs)
      phaseTimer.unref()
      enqueue(encodeRelayCarrierControl({ ...greeting.data, generation }), false)
    })
    socket.on("unexpected-response", (_request, response) => { response.destroy(); fail("registration") })
    socket.on("error", (error: Error & { code?: string }) => {
      const code = error.code ?? ""
      if (/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(code)) fail("tls")
      else if (code.startsWith("WS_ERR")) fail("protocol")
      else fail(undefined)
    })
    socket.on("close", () => fail(undefined))
    // A peer cannot bypass the bounded application queue with automatic pongs.
    socket.on("ping", () => fail("protocol"))
    socket.on("pong", (bytes) => {
      if (fenced || !awaitingPong || !bytes.equals(Buffer.from(awaitingPong))) return
      clearTimeout(heartbeatTimer); awaitingPong = undefined; heartbeat()
    })
    socket.on("message", (data, binary) => {
      if (fenced) return
      try {
        if (!(data instanceof Buffer)) throw new Error("Unexpected relay frame type")
        if (binary) {
          if (!registered) throw new Error("Relay registration is not acknowledged")
          const frame = decodeRelayMultiplexedFrame(data)
          if (frame.channelId > highWater) throw new Error("Unknown relay channel")
          channels.get(frame.channelId)?.receive(frame.frame)
          return
        }
        const control = parseRelayCarrierControl(data)
        if (!registered) {
          if (control.kind !== "registered" || control.generation !== generation) throw new Error("Relay registration mismatch")
          clearTimeout(phaseTimer); registered = true; heartbeat(); report({ state: "registered" }); return
        }
        if (control.kind === "close") {
          if (control.channelId > highWater) throw new Error("Unknown relay channel")
          closeChannel(control.channelId, false); return
        }
        if (control.kind !== "open" || control.channelId !== highWater + 1) throw new Error("Invalid relay channel sequence")
        highWater = control.channelId
        if (channels.size >= policy.maximumChannels) { fail("capacity"); return }
        const id = control.channelId
        const channel = endpoint.openChannel({ context: { relayProtocol: 1, routeId: options.routeId, channel: recovery.identity.channel }, carrier: {
          get bufferedAmount() { return queuedBytes + socket.bufferedAmount },
          send: (frame) => { if (!fenced && channels.has(id)) enqueue(encodeRelayMultiplexedFrame(id, frame), true) },
          close: () => { if (channels.has(id)) closeChannel(id, true) },
        } })
        if (!channel.closed && !fenced) channels.set(id, channel)
        else closeChannel(id, true)
      } catch { fail("protocol") }
    })
  }
  return {
    start() { if (started || stopped) return; started = true; begin() },
    async stop() { stopped = true; clearTimeout(retry); retire?.(); report({ state: "stopped" }); await dialing; await generations.close() },
    get status() { return { ...status } },
  }
}
