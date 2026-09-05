import {
  fleetEnrollParamsSchema, fleetEnrollResultSchema, fleetEntryMachineId,
  fleetForgetParamsSchema, fleetForgetResultSchema, fleetMachineDescriptorSchema,
  maximumFleetMachines, maximumFleetEntries, protocolCompatibility, protocolVersion,
  type FleetEnrollParams, type FleetEnrollRefusal, type FleetEnrollResult,
  type FleetForgetParams, type FleetForgetResult,
  type FleetMachineFacts, type FleetRemoteRevocation, type FleetSnapshot,
} from "@getdomovoi/protocol"

import { createMachineDialer, type MachineConnection, type MachineRouteConnection } from "./machine-dial.js"
import { machineCredentialDigest, MachineCredentialUnavailableError, type MachineCredentials } from "./machine-credentials.js"
import { fleetOperationSummary, type FleetEnrollmentOperation, type FleetForgetOperation } from "./fleet-operations.js"
import {
  FleetLimitReachedError, FleetOperationInProgressError, FleetSnapshotOverflowError,
  type EnrolledFleetMachine, type FleetConnectionFailure, type FleetRegistry,
} from "./fleet-registry.js"
import {
  claimMachineSocket, defaultMachineCallTimeoutMs, defaultMachineHandshakeTimeoutMs,
  MachineDescriptorError, MachineIdentityMismatchError, MachinePairingRequiredError,
  MachineProtocolMismatchError, MachineSelfEnrollmentError, openMachineSocket, readMachineDescriptor,
} from "./machine-socket.js"
import { OperationDeadline, validateOperationDeadlineBudget } from "./operation-deadline.js"

export const defaultFleetOperationTimeoutMs = 30_000
export const defaultFleetHeartbeatIntervalMs = 15_000

type Options = {
  selfId: string
  registry: FleetRegistry | undefined
  credentials: MachineCredentials | undefined
  operationTimeoutMs: number
  heartbeatIntervalMs: number
  changed: (snapshot: FleetSnapshot) => void
  recordLocal?: () => void
  reportFailure?: (context: string) => void
  // Test dependencies remain below the production factory, not on the wire.
  claim?: typeof claimMachineSocket
  open?: typeof openMachineSocket
  now?: () => number
}

export class FleetEnrollmentService {
  readonly #input: Options
  readonly #now: () => number
  readonly #lifetime = new AbortController()
  readonly #tasks = new Set<Promise<unknown>>()
  readonly #heartbeats = new Map<string, AbortController>()
  #knownCredentialIds: string[] = []
  #timer: ReturnType<typeof setTimeout> | undefined
  #started = false
  #stopped = false
  // Only fleet lifecycle calls serialize. They never hold the session/global
  // mutation queue. Before claim the target identity is unknown, so endpoint
  // locks would let two aliases race to replace the same remote credential.
  #lifecycleBusy = false

  constructor(input: Options) {
    validateOperationDeadlineBudget(input.operationTimeoutMs)
    validateOperationDeadlineBudget(input.heartbeatIntervalMs)
    this.#input = input
    this.#now = input.now ?? Date.now
  }

  snapshot(): FleetSnapshot {
    const registry = this.#input.registry
    if (!registry) return { entries: [] }
    this.#input.recordLocal?.()
    try { this.#knownCredentialIds = this.#input.credentials?.machines() ?? [] }
    catch {
      for (const entry of registry.enrolled()) {
        registry.recordFailure(entry.facts.id, entry.credentialDigest, "credential-store-unavailable")
      }
    }
    return registry.snapshot(this.#input.selfId, this.#now(), this.#knownCredentialIds)
  }

  start(): void {
    if (this.#started || this.#stopped) return
    this.#started = true
    const tick = async () => {
      try { await this.reconcile(); await this.refresh(); this.#changed() }
      catch { this.#input.reportFailure?.("Fleet reconciliation could not read or persist lifecycle state") }
    }
    // Intentional long-lived scheduler; attempts themselves remain bounded.
    // A silent peer cannot delay the next healthy peer's heartbeat. In-flight
    // machine IDs deduplicate across ticks instead of serializing the fleet.
    this.#timer = setInterval(() => { void this.#track(tick()).catch(() => {}) }, this.#input.heartbeatIntervalMs)
    this.#timer.unref?.()
    void this.#track(tick()).catch(() => {})
  }

  async stop(): Promise<void> {
    this.#stopped = true
    clearInterval(this.#timer)
    this.#lifetime.abort()
    for (const id of [...this.#heartbeats.keys()]) this.#cancelHeartbeat(id)
    await Promise.allSettled([...this.#tasks])
  }

  enroll(params: FleetEnrollParams): Promise<FleetEnrollResult> { return this.#track(this.#enroll(params)) }
  forget(params: FleetForgetParams): Promise<FleetForgetResult> { return this.#track(this.#forget(params)) }
  reconcile(): Promise<void> { return this.#track(this.#reconcile()) }
  refresh(): Promise<void> { return this.#track(this.#refresh()) }

  #track<T>(task: Promise<T>): Promise<T> {
    this.#tasks.add(task)
    void task.then(() => this.#tasks.delete(task), () => this.#tasks.delete(task))
    return task
  }

  #deadline(): OperationDeadline {
    return OperationDeadline.start(this.#input.operationTimeoutMs, { signal: this.#lifetime.signal })
  }

  #changed(): void {
    if (this.#stopped) return
    // A vanished/slow client cannot roll back an already durable lifecycle
    // change. Reconnect relists, and outbound policy closes rather than drops.
    try { this.#input.changed(this.snapshot()) } catch { /* The next relist retries the read. */ }
  }

  async #enroll(raw: FleetEnrollParams): Promise<FleetEnrollResult> {
    const params = fleetEnrollParamsSchema.parse(raw)
    const { registry, credentials, selfId } = this.#input
    if (!registry) return { outcome: "refused", reason: "fleet-unavailable" }
    if (!credentials) return { outcome: "refused", reason: "credential-store-unavailable" }
    if (params.expectedMachineId === selfId) return { outcome: "refused", reason: "self-enrollment" }
    if (this.#lifecycleBusy) return { outcome: "refused", reason: "operation-in-progress" }
    this.#lifecycleBusy = true
    const deadline = this.#deadline()
    let claimed: Awaited<ReturnType<typeof claimMachineSocket>> | undefined
    let operation: FleetEnrollmentOperation | undefined
    try {
      deadline.throwIfExpired()
      // Discover a locked keychain before spending a one-time pairing code.
      this.#knownCredentialIds = credentials.machines()
      const entries = this.snapshot().entries
      if (params.expectedMachineId && registry.pendingOperations().some((entry) => entry.machineId === params.expectedMachineId)) {
        throw new FleetOperationInProgressError()
      }
      const admitted = entries.filter((entry) => entry.kind === "machine" || (entry.kind === "pending" && entry.operation === "enroll"))
      if ((admitted.length >= maximumFleetMachines && !admitted.some((entry) => fleetEntryMachineId(entry) === params.expectedMachineId))
        || (entries.length >= maximumFleetEntries && !entries.some((entry) => fleetEntryMachineId(entry) === params.expectedMachineId))) {
        throw new FleetLimitReachedError()
      }
      claimed = await (this.#input.claim ?? claimMachineSocket)({
        endpoint: params.endpoint, code: params.code, sourceDeviceLabel: params.sourceDeviceLabel,
        sourceMachineId: selfId, ...(params.expectedMachineId ? { expectedMachineId: params.expectedMachineId } : {}),
        deadline, callTimeoutMs: defaultMachineCallTimeoutMs, signal: this.#lifetime.signal,
      })
      const receivedAt = this.#now()
      deadline.throwIfExpired()
      const parsed = fleetMachineDescriptorSchema.safeParse(claimed.descriptor)
      if (!parsed.success) throw new MachineDescriptorError()
      const descriptor = parsed.data
      if (descriptor.id === selfId) throw new MachineSelfEnrollmentError()
      if (params.expectedMachineId && params.expectedMachineId !== descriptor.id) throw new MachineIdentityMismatchError()
      if (protocolCompatibility(protocolVersion, descriptor.protocolVersion) !== "compatible") throw new MachineProtocolMismatchError()
      if (JSON.stringify({ descriptor, endpoint: claimed.endpoint }).includes(claimed.credential)) throw new MachineDescriptorError()
      this.#cancelHeartbeat(descriptor.id)
      operation = registry.stageEnrollment({
        ...descriptor, connection: "direct",
        verifiedRoute: { endpoint: claimed.endpoint, lastAuthenticatedAt: new Date(receivedAt).toISOString() },
      }, machineCredentialDigest(descriptor.id, claimed.credential), receivedAt)
      this.#changed()
      try { credentials.save(descriptor.id, claimed.credential) } catch { /* Read back; a write can fail after changing the key. */ }
      const settled = this.#settleEnrollment(operation, deadline)
      this.#changed()
      if (settled === "enrolled") return fleetEnrollResultSchema.parse({ outcome: "enrolled", machineId: descriptor.id, fleet: this.snapshot() })
      if (settled === "aborted") {
        await this.#revokeUnkeptClaim(claimed.connection, deadline)
        return { outcome: "refused", reason: "credential-store-unavailable" }
      }
      return this.#pendingEnrollment(operation)
    } catch (error) {
      if (operation && registry.pendingOperations().some((entry) => entry.id === operation!.id)) return this.#pendingEnrollment(operation)
      if (claimed) await this.#revokeUnkeptClaim(claimed.connection, deadline)
      return { outcome: "refused", reason: enrollRefusal(error) }
    } finally {
      claimed?.connection.close()
      deadline.clear()
      this.#lifecycleBusy = false
    }
  }

  #pendingEnrollment(operation: FleetEnrollmentOperation): FleetEnrollResult {
    return fleetEnrollResultSchema.parse({ outcome: "pending", operation: fleetOperationSummary(operation), fleet: this.snapshot() })
  }

  #settleEnrollment(operation: FleetEnrollmentOperation, deadline: OperationDeadline): "enrolled" | "pending" | "aborted" {
    const { registry, credentials } = this.#input
    try {
      deadline.throwIfExpired()
      const stored = credentials!.forMachine(operation.machineId)
      if (!stored || machineCredentialDigest(operation.machineId, stored) !== operation.credentialDigest) {
        registry!.abortEnrollment(operation.id)
        return "aborted"
      }
      // Repair an index write that failed after the secret was already saved.
      // Restart can repeat this because only the matching OS key supplies bytes.
      credentials!.save(operation.machineId, stored)
      if (!credentials!.machines().includes(operation.machineId)) return "pending"
      const readback = credentials!.forMachine(operation.machineId)
      deadline.throwIfExpired()
      if (!readback || machineCredentialDigest(operation.machineId, readback) !== operation.credentialDigest) return "pending"
      return registry!.completeEnrollment(operation.id, operation.credentialDigest) ? "enrolled" : "pending"
    } catch { return "pending" }
  }

  async #revokeUnkeptClaim(connection: MachineConnection, parent: OperationDeadline): Promise<void> {
    if (parent.remainingMs() === 0) return
    const deadline = parent.limit(1_000)
    try { await connection.call("device.revokeCurrent", {}, undefined, deadline) } catch { /* No false claim of remote revocation. */ }
    finally { deadline.clear() }
  }

  async #forget(raw: FleetForgetParams): Promise<FleetForgetResult> {
    const params = fleetForgetParamsSchema.parse(raw)
    const { registry, credentials, selfId } = this.#input
    if (params.machineId === selfId) return { outcome: "refused", reason: "self-forget" }
    if (!registry) return { outcome: "refused", reason: "fleet-unavailable" }
    if (!credentials) return { outcome: "refused", reason: "credential-store-unavailable" }
    if (this.#lifecycleBusy || registry.pendingOperations().some((entry) => entry.machineId === params.machineId)) {
      return { outcome: "refused", reason: "operation-in-progress" }
    }
    this.#lifecycleBusy = true
    const deadline = this.#deadline()
    let operation: FleetForgetOperation | undefined
    try {
      deadline.throwIfExpired()
      this.#knownCredentialIds = credentials.machines()
      if (!this.snapshot().entries.some((entry) => fleetEntryMachineId(entry) === params.machineId)) {
        return { outcome: "refused", reason: "not-enrolled" }
      }
      const credential = credentials.forMachine(params.machineId)
      const digest = credential === undefined ? null : machineCredentialDigest(params.machineId, credential)
      this.#cancelHeartbeat(params.machineId)
      operation = registry.stageForget(params.machineId, digest, this.#now())
      this.#changed()
      const revocation = await this.#settleForget(operation, deadline)
      this.#changed()
      if (revocation !== undefined) return fleetForgetResultSchema.parse({
        outcome: "forgotten", machineId: params.machineId, remoteRevocation: revocation, fleet: this.snapshot(),
      })
      return this.#pendingForget(operation)
    } catch {
      return operation ? this.#pendingForget(operation) : { outcome: "refused", reason: "credential-store-unavailable" }
    } finally { deadline.clear(); this.#lifecycleBusy = false }
  }

  #pendingForget(operation: FleetForgetOperation): FleetForgetResult {
    const current = this.#input.registry!.pendingOperations().find((entry) => entry.id === operation.id)
    const remoteRevocation = current?.kind === "forget" ? current.remoteRevocation : operation.remoteRevocation
    return fleetForgetResultSchema.parse({ outcome: "pending", operation: fleetOperationSummary(operation), remoteRevocation, fleet: this.snapshot() })
  }

  async #settleForget(operation: FleetForgetOperation, deadline: OperationDeadline): Promise<FleetRemoteRevocation | undefined> {
    const { registry, credentials } = this.#input
    try {
      deadline.throwIfExpired()
      const held = credentials!.forMachine(operation.machineId)
      if (held !== undefined && machineCredentialDigest(operation.machineId, held) !== operation.credentialDigest) return undefined
      let revocation = operation.remoteRevocation
      const enrollment = registry!.pendingForgetEnrollment(operation.id)
      if (held && enrollment && revocation !== "confirmed") {
        // Leave budget for local deletion even when the remote will not answer.
        const remoteDeadline = deadline.limit(this.#input.operationTimeoutMs / 2)
        let connection: MachineRouteConnection | undefined
        try {
          connection = await this.#dial([enrollment.facts], operation.machineId, remoteDeadline)
          const result = await connection.call("device.revokeCurrent", {}, undefined, remoteDeadline)
          remoteDeadline.throwIfExpired()
          if (result && typeof result === "object" && "revoked" in result && result.revoked === true) {
            revocation = "confirmed"
            registry!.confirmRemoteRevocation(operation.id)
          }
        } catch { /* Unreachable/refused is not proof the remote revoked it. */ }
        finally { connection?.close(); remoteDeadline.clear() }
      }
      deadline.throwIfExpired()
      // Re-read after the remote await. A replacement key is not the key this
      // operation was authorised to delete, so keep the pending row visible.
      const current = credentials!.forMachine(operation.machineId)
      if (current !== undefined && machineCredentialDigest(operation.machineId, current) !== operation.credentialDigest) return undefined
      credentials!.forget(operation.machineId)
      if (credentials!.forMachine(operation.machineId) !== undefined || credentials!.machines().includes(operation.machineId)) return undefined
      deadline.throwIfExpired()
      return registry!.completeForget(operation.id) ? revocation : undefined
    } catch { return undefined }
  }

  async #reconcile(): Promise<void> {
    if (this.#stopped || this.#lifecycleBusy || !this.#input.registry || !this.#input.credentials) return
    this.#lifecycleBusy = true
    try {
      await Promise.all(this.#input.registry.pendingOperations().map(async (operation) => {
        const deadline = this.#deadline()
        try {
          if (operation.kind === "enroll") this.#settleEnrollment(operation, deadline)
          else await this.#settleForget(operation, deadline)
        } finally { deadline.clear() }
      }))
      this.#changed()
    } finally { this.#lifecycleBusy = false }
  }

  async #refresh(): Promise<void> {
    if (this.#stopped || !this.#input.registry) return
    // One bounded attempt per enrolled ID. The registry's 128-entry limit
    // bounds live probes, and a pending lifecycle operation is excluded here.
    await Promise.all(this.#input.registry.enrolled().map((entry) => this.#heartbeat(entry)))
  }

  async #heartbeat(entry: EnrolledFleetMachine): Promise<void> {
    const id = entry.facts.id
    if (id === this.#input.selfId || this.#heartbeats.has(id)) return
    const controller = new AbortController()
    this.#heartbeats.set(id, controller)
    const deadline = OperationDeadline.start(this.#input.operationTimeoutMs, {
      signal: AbortSignal.any([this.#lifetime.signal, controller.signal]),
    })
    let connection: MachineRouteConnection | undefined
    try {
      const credential = this.#input.credentials?.forMachine(id)
      if (!this.#input.credentials) throw new MachineCredentialUnavailableError()
      if (!credential || machineCredentialDigest(id, credential) !== entry.credentialDigest) throw new MachinePairingRequiredError()
      connection = await this.#dial([entry.facts], id, deadline, controller.signal)
      const descriptor = await readMachineDescriptor(connection, id, credential, deadline)
      const receivedAt = this.#now()
      if (this.#heartbeats.get(id) !== controller || this.#stopped) return
      const held = this.#input.credentials.forMachine(id)
      if (!held || machineCredentialDigest(id, held) !== entry.credentialDigest) throw new MachinePairingRequiredError()
      deadline.throwIfExpired()
      this.#input.registry!.refreshAuthenticated({
        ...descriptor, connection: "direct",
        verifiedRoute: { endpoint: connection.endpoint, lastAuthenticatedAt: new Date(receivedAt).toISOString() },
      }, entry.credentialDigest, receivedAt)
    } catch (error) {
      if (this.#heartbeats.get(id) === controller && !this.#stopped) {
        this.#input.registry!.recordFailure(id, entry.credentialDigest, connectionFailure(error, entry.facts.protocolVersion))
      }
    } finally {
      connection?.close()
      deadline.clear()
      if (this.#heartbeats.get(id) === controller) this.#heartbeats.delete(id)
      this.#changed()
    }
  }

  #cancelHeartbeat(id: string): void {
    const controller = this.#heartbeats.get(id)
    this.#heartbeats.delete(id)
    controller?.abort()
  }

  #dial(machines: FleetMachineFacts[], machineId: string, deadline: OperationDeadline, signal?: AbortSignal): Promise<MachineRouteConnection> {
    return createMachineDialer({
      machine: (id) => machines.find((machine) => machine.id === id), credentials: this.#input.credentials, dialTimeoutMs: defaultMachineHandshakeTimeoutMs,
      open: (input) => (this.#input.open ?? openMachineSocket)({ ...input, callTimeoutMs: defaultMachineCallTimeoutMs }),
    })(machineId, signal, deadline)
  }
}

function enrollRefusal(error: unknown): FleetEnrollRefusal {
  if (error instanceof MachineCredentialUnavailableError) return "credential-store-unavailable"
  if (error instanceof MachinePairingRequiredError) return "pairing-refused"
  if (error instanceof MachineProtocolMismatchError) return "protocol-mismatch"
  if (error instanceof MachineIdentityMismatchError) return "identity-mismatch"
  if (error instanceof MachineSelfEnrollmentError) return "self-enrollment"
  if (error instanceof MachineDescriptorError) return "target-description-invalid"
  if (error instanceof FleetLimitReachedError || error instanceof FleetSnapshotOverflowError) return "fleet-limit"
  if (error instanceof FleetOperationInProgressError) return "operation-in-progress"
  return "target-unreachable"
}

function connectionFailure(error: unknown, lastAdvertisedProtocol: string): FleetConnectionFailure {
  if (error instanceof MachineCredentialUnavailableError) return "credential-store-unavailable"
  if (error instanceof MachinePairingRequiredError || error instanceof MachineIdentityMismatchError) return "pairing-required"
  if (error instanceof MachineProtocolMismatchError) {
    // A refusal names the peer's version. Without one, the version the peer
    // last advertised says which side has to move.
    const remote = error.remoteVersion ?? lastAdvertisedProtocol
    return protocolCompatibility(remote, protocolVersion) === "machine-behind" ? "upgrade-required" : "version-mismatch"
  }
  return "reconnecting"
}
