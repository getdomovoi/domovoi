import { WebSocket } from "ws"

import {
  daemonAuthenticationErrorCode,
  credentialSchema,
  devicePairResultSchema,
  fleetDirectEndpointSchema,
  fleetMachineDescriptorSchema,
  machineIdSchema,
  protocolCompatibility,
  protocolMismatchSchema,
  protocolVersion,
  protocolVersionMismatchErrorCode,
  rpcResponseSchema,
  systemHelloResultSchema,
  type FleetMachineDescriptor,
} from "@getdomovoi/protocol"

import type { MachineConnection } from "./machine-dial.js"
import { OperationDeadline, OperationDeadlineExceededError, validateOperationDeadlineBudget } from "./operation-deadline.js"
import { redactDurableText } from "./secret-redaction.js"

export const defaultMachineHandshakeTimeoutMs = 15_000
export const defaultMachineCallTimeoutMs = 120_000
export const defaultMaximumPendingCalls = 64

export class MachinePairingRequiredError extends Error {
  constructor() {
    super("That machine must be paired again")
    this.name = "MachinePairingRequiredError"
  }
}

export class MachineIdentityMismatchError extends Error {
  constructor() { super("The endpoint answered as a different machine"); this.name = "MachineIdentityMismatchError" }
}

export class MachineProtocolMismatchError extends Error {
  readonly remoteVersion: string | undefined
  constructor(remoteVersion?: string) {
    const safeVersion = remoteVersion !== undefined && remoteVersion.length <= 64 && /^\d+\.\d+\.\d+$/.test(remoteVersion)
      ? remoteVersion : undefined
    super(safeVersion === undefined ? "That machine speaks an incompatible protocol"
      : `That machine speaks protocol ${safeVersion}, this daemon speaks ${protocolVersion}`)
    this.name = "MachineProtocolMismatchError"
    this.remoteVersion = safeVersion
  }
}

// A daemon refuses a hello on another protocol with a sentence that names its
// own version first. Clients show that sentence; the refusal's data names the
// same version for the dialer, so the fleet can say which side has to move.
export function protocolMismatchRefusal(daemonProtocol: string, clientProtocol: string): string {
  return `This daemon speaks protocol ${daemonProtocol}; the client speaks ${clientProtocol}`
}

const protocolMismatchRefusalPattern = /^This daemon speaks protocol (\d+\.\d+\.\d+); the client speaks /

// A daemon from before the refusal carried data names its version in the
// sentence alone.
function refusedDaemonProtocol(error: { message: string; data?: unknown }): string | undefined {
  const mismatch = protocolMismatchSchema.safeParse(error.data)
  if (mismatch.success) return mismatch.data.daemonProtocolVersion
  return protocolMismatchRefusalPattern.exec(error.message)?.[1]
}

export class MachineDescriptorError extends Error {
  constructor() { super("That machine returned an invalid descriptor"); this.name = "MachineDescriptorError" }
}

export class MachineSelfEnrollmentError extends Error {
  constructor() { super("This daemon cannot enroll itself"); this.name = "MachineSelfEnrollmentError" }
}

export class MachineRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = "MachineRpcError" }
}

type SocketInput = {
  endpoint: string
  // Required at the resource seam. One caller-owned deadline bounds TCP/TLS,
  // upgrade, claim, hello and the initial descriptor, including fallback.
  deadline: OperationDeadline
  callTimeoutMs: number
  maximumPendingCalls?: number
  signal?: AbortSignal
}

type PendingCall = { resolve(result: unknown): void; reject(error: Error): void }
type MachineChannel = MachineConnection & {
  finishHandshake(): void
  rememberSecret(secret: string): void
}

function deadlineError(deadline: OperationDeadline, opening: boolean): Error {
  return deadline.signal.reason instanceof OperationDeadlineExceededError
    ? new Error(opening ? "That machine did not answer before the deadline" : "That machine stopped answering before the deadline")
    : new Error("The transfer was cancelled")
}

function openMachineChannel(input: SocketInput): Promise<MachineChannel> {
  input.deadline.throwIfExpired()
  if (input.signal?.aborted) return Promise.reject(new Error("The transfer was cancelled"))
  validateOperationDeadlineBudget(input.callTimeoutMs)
  if (!fleetDirectEndpointSchema.safeParse(input.endpoint).success) {
    return Promise.reject(new Error("Refusing to authenticate over an unencrypted connection or unsafe endpoint"))
  }
  const maximumPendingCalls = input.maximumPendingCalls ?? defaultMaximumPendingCalls
  if (!Number.isSafeInteger(maximumPendingCalls) || maximumPendingCalls < 1 || maximumPendingCalls > 1024) {
    throw new RangeError("Machine pending-call limit must be between 1 and 1024")
  }
  return new Promise<MachineChannel>((resolve, reject) => {
    const socket = new WebSocket(input.endpoint, { maxPayload: 2 * 1024 * 1024, followRedirects: false })
    const pending = new Map<number, PendingCall>()
    const secrets = new Set<string>()
    let nextId = 0
    let closed = false
    let established = false
    const detachOpening = () => input.deadline.signal.removeEventListener("abort", abortOpening)
    const fail = (error: Error) => {
      if (closed) return
      closed = true
      detachOpening()
      input.signal?.removeEventListener("abort", abortLifetime)
      reject(error)
      for (const call of [...pending.values()]) call.reject(error)
      // Deadlines must release the socket now, not after another close timeout.
      socket.terminate()
    }
    const abortOpening = () => { if (!established) fail(deadlineError(input.deadline, true)) }
    const abortLifetime = () => fail(new Error("The transfer was cancelled"))
    input.deadline.signal.addEventListener("abort", abortOpening, { once: true })
    input.signal?.addEventListener("abort", abortLifetime, { once: true })

    const send: MachineConnection["call"] = (method, params, signal, parentDeadline) => {
      if (closed || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("The machine connection is closed"))
      if (pending.size >= maximumPendingCalls) return Promise.reject(new Error("Too many calls are waiting on that machine"))
      if (signal?.aborted || input.signal?.aborted) return Promise.reject(new Error("The transfer was cancelled"))
      const deadline = parentDeadline?.limit(input.callTimeoutMs) ?? OperationDeadline.start(input.callTimeoutMs)
      if (deadline.remainingMs() === 0) {
        deadline.clear()
        return Promise.reject(deadlineError(deadline, !established))
      }
      return new Promise<unknown>((settle, rejectCall) => {
        const id = ++nextId
        const cleanup = () => {
          pending.delete(id)
          deadline.clear()
          deadline.signal.removeEventListener("abort", abortDeadline)
          signal?.removeEventListener("abort", abortSignal)
        }
        const abortDeadline = () => {
          cleanup()
          rejectCall(deadlineError(deadline, !established))
        }
        const abortSignal = () => { cleanup(); rejectCall(new Error("The transfer was cancelled")) }
        deadline.signal.addEventListener("abort", abortDeadline, { once: true })
        signal?.addEventListener("abort", abortSignal, { once: true })
        pending.set(id, {
          // The timer can be delayed by a busy event loop. Check the clock at
          // settlement too, before a late reply can become durable state.
          resolve: (result) => { if (deadline.remainingMs() === 0) return; cleanup(); settle(result) },
          reject: (error) => { if (deadline.remainingMs() === 0) return; cleanup(); rejectCall(error) },
        })
        try {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (error) => {
            if (error) pending.get(id)?.reject(new Error("The machine request could not be sent"))
          })
        } catch {
          pending.get(id)?.reject(new Error("The machine request could not be sent"))
        }
      })
    }
    socket.on("error", () => fail(new Error("That machine did not answer")))
    socket.on("close", () => fail(new Error("The machine closed the connection")))
    socket.on("message", (data) => {
      if (closed) return
      let parsed: unknown
      try { parsed = JSON.parse(data.toString()) } catch { return }
      const response = rpcResponseSchema.safeParse(parsed)
      if (!response.success || typeof response.data.id !== "number") return
      const call = pending.get(response.data.id)
      if (!call) return
      if (response.data.error) {
        const error = response.data.error
        if (error.code === daemonAuthenticationErrorCode) call.reject(new MachinePairingRequiredError())
        else if (error.code === protocolVersionMismatchErrorCode) call.reject(new MachineProtocolMismatchError(refusedDaemonProtocol(error)))
        else {
          let message = error.message
          for (const secret of secrets) message = message.replaceAll(secret, "[REDACTED]")
          call.reject(new MachineRpcError(error.code, redactDurableText(message).value.slice(0, 1024)))
        }
      } else call.resolve(response.data.result)
    })
    socket.on("open", () => {
      if (closed) return
      resolve({
        call: send,
        close: () => fail(new Error("The machine connection is closed")),
        finishHandshake: () => { input.deadline.throwIfExpired(); established = true; detachOpening() },
        rememberSecret: (secret) => { secrets.add(secret) },
      })
    })
  })
}

function handshakeIdentity(result: unknown): string {
  const version = result && typeof result === "object" && "protocolVersion" in result ? result.protocolVersion : undefined
  // An untrusted error must not turn arbitrary peer text into a logged version.
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || version.length > 64) {
    throw new MachineDescriptorError()
  }
  if (protocolCompatibility(protocolVersion, version) !== "compatible") {
    throw new MachineProtocolMismatchError(version)
  }
  // The durable snapshot schema pins our local version. Compatible peers can
  // differ in patch version; validate their full shape without changing any
  // published remote fact. Only the checked identity leaves this function.
  const snapshot = systemHelloResultSchema.safeParse({ ...result as object, protocolVersion })
  if (snapshot.success) return machineIdSchema.parse(snapshot.data.machine.id)
  throw new MachineDescriptorError()
}

async function greet(channel: MachineChannel, credential: string, deadline: OperationDeadline): Promise<string> {
  channel.rememberSecret(credential)
  const result = await channel.call("system.hello", {
    client: "machine", clientVersion: "0.0.1", protocolVersion, authToken: credential,
  }, undefined, deadline)
  return handshakeIdentity(result)
}

export async function openMachineSocket(input: SocketInput & {
  expectedMachineId: string
  credential: string
}): Promise<MachineConnection> {
  machineIdSchema.parse(input.expectedMachineId)
  if (!credentialSchema.safeParse(input.credential).success) throw new MachinePairingRequiredError()
  const channel = await openMachineChannel(input)
  try {
    const id = await greet(channel, input.credential, input.deadline)
    if (id !== input.expectedMachineId) throw new MachineIdentityMismatchError()
    channel.finishHandshake()
    return { call: channel.call, close: channel.close }
  } catch (error) { channel.close(); throw error }
}

export async function claimMachineSocket(input: SocketInput & {
  sourceMachineId: string
  expectedMachineId?: string
  sourceDeviceLabel: string
  code: string
}): Promise<{
  connection: MachineConnection
  credential: string
  descriptor: FleetMachineDescriptor
  endpoint: string
}> {
  const channel = await openMachineChannel(input)
  let authenticated = false
  try {
    const rawClaim = await channel.call("device.claim", {
      code: input.code, label: input.sourceDeviceLabel, machineId: input.sourceMachineId, protocolVersion,
    }, undefined, input.deadline)
    const claim = devicePairResultSchema.safeParse(rawClaim)
    if (!claim.success || claim.data.device.binding.kind !== "machine"
      || claim.data.device.binding.machineId !== input.sourceMachineId || claim.data.device.revokedAt !== undefined) {
      throw new Error("That machine returned an invalid credential binding")
    }
    const credential = claim.data.token
    const id = await greet(channel, credential, input.deadline)
    authenticated = true
    if (input.expectedMachineId !== undefined && id !== input.expectedMachineId) throw new MachineIdentityMismatchError()
    if (id === input.sourceMachineId) throw new MachineSelfEnrollmentError()
    const descriptor = await readMachineDescriptor(channel, id, credential, input.deadline)
    channel.finishHandshake()
    return { connection: { call: channel.call, close: channel.close }, credential, descriptor, endpoint: input.endpoint }
  } catch (error) {
    if (authenticated && input.deadline.remainingMs() > 0) {
      // A claim that never reaches the coordinator must not leave avoidable
      // authority behind. Best effort only, on this authenticated socket and
      // within the original budget; never replace the original refusal.
      const cleanup = input.deadline.limit(1_000)
      try { await channel.call("device.revokeCurrent", {}, undefined, cleanup) } catch { /* No confirmed-revocation claim. */ }
      finally { cleanup.clear() }
    }
    channel.close()
    throw error
  }
}

export async function readMachineDescriptor(
  connection: MachineConnection,
  expectedMachineId: string,
  credential: string,
  deadline: OperationDeadline,
): Promise<FleetMachineDescriptor> {
  const result = await connection.call("fleet.heartbeat", {}, undefined, deadline)
  const parsed = fleetMachineDescriptorSchema.safeParse(result)
  if (!parsed.success || JSON.stringify(parsed.data).includes(credential)) throw new MachineDescriptorError()
  if (parsed.data.id !== expectedMachineId) throw new MachineIdentityMismatchError()
  if (protocolCompatibility(protocolVersion, parsed.data.protocolVersion) !== "compatible") {
    throw new MachineProtocolMismatchError(parsed.data.protocolVersion)
  }
  deadline.throwIfExpired()
  return parsed.data
}
