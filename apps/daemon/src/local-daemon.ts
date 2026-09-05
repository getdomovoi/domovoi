import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

import { protocolCompatibility, protocolVersion, protocolVersionMismatchErrorCode, rpcMethods } from "@getdomovoi/protocol"
import { WebSocket } from "ws"

import { beforeDeadline, OperationDeadline, OperationDeadlineExceededError } from "./operation-deadline.js"
import { verifyLocalOwnerProof } from "./local-owner-proof.js"
import {
  readLocalOwnerCredential, readLocalOwnerRecord, readLocalOwnerSecret, readLocalProfileFile, type ReadyLocalOwner,
} from "./local-owner-record.js"
import { claimProfile, ProfileAlreadyOwnedError, type ProfileLease } from "./profile-lease.js"
import { retireRemovedLocalOwner } from "./local-owner-removal.js"
import {
  createProductionDaemonWithDependencies, productionDaemonDependencies,
  type ProductionDaemonHandle, type ProductionDaemonOptions,
} from "./production-daemon.js"
import { serviceConfigurationPath } from "./service/configuration.js"

export type LocalDaemonRefusalReason =
  | "owner-busy" | "owner-unreachable" | "owner-incompatible" | "owner-unverified" | "profile-invalid"
export type LocalDaemonEndpoint = { url: string; token: string }
export type LocalDaemonHandle =
  | { kind: "owned"; endpoint: LocalDaemonEndpoint; stop(): Promise<void> }
  | { kind: "attached"; owner: "daemon" | "desktop"; endpoint: LocalDaemonEndpoint; closed: Promise<void>; detach(): void }
  | { kind: "refused"; reason: LocalDaemonRefusalReason; message: string }
export type AcquireLocalDaemonOptions = Omit<ProductionDaemonOptions, "owner" | "serviceRegistrationId"> & {
  // Reconnects must rediscover the owner, never turn a restart gap into a new
  // Desktop daemon. Each attempt gets one finite budget before any resource.
  mode: "start-or-attach" | "attach-only"
  timeoutMs: number
}

const refusalMessages = {
  "owner-busy": "The local daemon owner changed during discovery. Try connecting again; no second daemon was started.",
  "owner-unreachable": "The profile has no reachable owner. Wait for the daemon to restart, or start it explicitly. No fallback daemon was started.",
  "owner-incompatible": "The local daemon uses an incompatible protocol. Update the daemon and Desktop, then reconnect.",
  "owner-unverified": "The local daemon could not prove its identity or accept this profile's credential. Check the running daemon and its profile; no fallback daemon was started.",
  "profile-invalid": "The local daemon profile is invalid or inaccessible. Check its owner record, private key and credential file before retrying.",
} satisfies Record<LocalDaemonRefusalReason, string>

class LocalDiscoveryError extends Error {
  constructor(readonly reason: LocalDaemonRefusalReason) { super(refusalMessages[reason]); this.name = "LocalDiscoveryError" }
}
function refused(reason: LocalDaemonRefusalReason): Extract<LocalDaemonHandle, { kind: "refused" }> {
  return { kind: "refused", reason, message: refusalMessages[reason] }
}

async function attach(
  homeDirectory: string, record: ReadyLocalOwner, environmentToken: string | undefined, deadline: OperationDeadline,
): Promise<Extract<LocalDaemonHandle, { kind: "attached" }>> {
  const secret = readLocalOwnerSecret(homeDirectory)
  const token = readLocalOwnerCredential(record, environmentToken)
  if (secret === token) throw new LocalDiscoveryError("profile-invalid")
  const ca = record.certificatePath ? readLocalProfileFile(record.certificatePath, 64 * 1024, false) : undefined
  deadline.throwIfExpired()
  return new Promise((settle, reject) => {
    const nonce = randomBytes(32).toString("base64url")
    // No bearer in headers or URL. The upgrade proof and authenticated hello
    // share this socket, so another process cannot replace a checked listener
    // between two independent connections. TLS verification remains enabled.
    const socket = new WebSocket(record.url, {
      headers: { "x-domovoi-owner-nonce": nonce },
      followRedirects: false, maxPayload: 2 * 1024 * 1024,
      ...(ca ? { ca } : {}),
    })
    // A lifetime notification, not a reconnect attempt or operation timeout.
    // It stays registered after discovery settles and never rejects.
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
    let settled = false
    let proved = false
    const cleanup = () => {
      deadline.signal.removeEventListener("abort", abort)
      socket.off("upgrade", upgrade)
      socket.off("open", open)
      socket.off("message", message)
    }
    const fail = (reason: LocalDaemonRefusalReason) => {
      if (settled) return
      settled = true
      cleanup()
      socket.terminate()
      reject(new LocalDiscoveryError(reason))
    }
    const abort = () => fail("owner-unreachable")
    const upgrade = (response: import("node:http").IncomingMessage) => {
      if (settled) return
      if (deadline.remainingMs() === 0) return abort()
      proved = verifyLocalOwnerProof(secret, record, nonce, response.headers["x-domovoi-owner-proof"])
      if (!proved) fail("owner-unverified")
    }
    const open = () => {
      if (settled) return
      if (deadline.remainingMs() === 0) return abort()
      if (!proved) return fail("owner-unverified")
      if (protocolCompatibility(protocolVersion, record.protocolVersion) !== "compatible") return fail("owner-incompatible")
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.hello", params: {
        client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: token,
      } }), (error) => { if (error) fail("owner-unreachable") })
    }
    const message = (data: WebSocket.RawData) => {
      if (settled) return
      if (deadline.remainingMs() === 0) return abort()
      try {
        const response = JSON.parse(data.toString()) as { id?: unknown; error?: { code?: unknown }; result?: unknown }
        if (response.id !== 1) return
        if (response.error) return fail(response.error.code === protocolVersionMismatchErrorCode ? "owner-incompatible" : "owner-unverified")
        const hello = rpcMethods["system.hello"].result.safeParse(response.result)
        if (!hello.success || hello.data.machine.id !== record.machineId) return fail("owner-unverified")
        // A restart may have replaced the record while hello was in flight.
        // Only return the endpoint that still belongs to this exact instance.
        const current = readLocalOwnerRecord(homeDirectory)
        if (current?.state !== "ready" || current.instanceId !== record.instanceId || current.url !== record.url) return fail("owner-busy")
        deadline.throwIfExpired()
        settled = true
        cleanup()
        settle({ kind: "attached", owner: record.owner, endpoint: { url: record.url, token }, closed, detach: () => socket.terminate() })
      } catch {
        fail("owner-unverified")
      }
    }
    socket.on("upgrade", upgrade)
    socket.on("open", open)
    socket.on("message", message)
    // Keep the error listener for the attachment lifetime, including detach.
    socket.on("error", () => fail("owner-unreachable"))
    socket.on("close", () => fail("owner-unreachable"))
    deadline.signal.addEventListener("abort", abort, { once: true })
    if (deadline.remainingMs() === 0) abort()
  })
}

export async function acquireLocalDaemon(options: AcquireLocalDaemonOptions): Promise<LocalDaemonHandle> {
  const deadline = OperationDeadline.start(options.timeoutMs)
  const homeDirectory = resolve(options.homeDirectory ?? homedir())
  let lease: ProfileLease | undefined
  let runtime: ProductionDaemonHandle | undefined
  try {
    try { lease = claimProfile(homeDirectory) } catch (error) {
      if (!(error instanceof ProfileAlreadyOwnedError)) throw error
    }
    deadline.throwIfExpired()
    const record = readLocalOwnerRecord(homeDirectory)
    if (!lease) {
      if (record?.state !== "ready") return refused("owner-unreachable")
      return await attach(homeDirectory, record, (options.environment ?? process.env).DOMOVOI_AUTH_TOKEN, deadline)
    }
    // Lease freedom alone is not a shutdown record. A crashed service keeps
    // its record, and an installed but restarting service keeps its config.
    if (options.mode !== "start-or-attach"
      || existsSync(serviceConfigurationPath(homeDirectory, process.platform))) return refused("owner-unreachable")
    if (record && record.state !== "none" && !retireRemovedLocalOwner(homeDirectory, lease, record, deadline)) return refused("owner-unreachable")
    deadline.throwIfExpired()
    const ownedLease = lease
    lease = undefined
    runtime = await createProductionDaemonWithDependencies({ ...options, homeDirectory, owner: "desktop" }, productionDaemonDependencies, {
      lease: ownedLease, deadline,
    })
    deadline.throwIfExpired()
    const endpoint = await beforeDeadline(runtime.start(), deadline)
    return { kind: "owned", endpoint: { url: endpoint.url, token: runtime.authToken }, stop: runtime.stop }
  } catch (error) {
    if (runtime) void runtime.stop().catch(() => {})
    return refused(error instanceof LocalDiscoveryError ? error.reason
      : error instanceof OperationDeadlineExceededError ? "owner-unreachable" : "profile-invalid")
  } finally {
    lease?.release()
    deadline.clear()
  }
}
