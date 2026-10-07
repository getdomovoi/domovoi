import {
  credentialSchema,
  type FleetEntry,
  type FleetMachine,
  type ProviderRuntime,
  type SessionSearchResult,
  type SessionSummary,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import type { DomovoiClient } from "./client.js"
import { ClientAdmissionError } from "./client-admission-policy.js"
import { Deadline } from "./deadline.js"
import { fleetAccessError, fleetClient, type FleetAccess } from "./fleet-access.js"
import type { FleetInventoryReader } from "./fleet-inventories.js"
import type { MachineAgents } from "./provider-settings.js"

// What a machine's own daemon said about its agents and sessions, and when.
// The machine card reads agents and session counts from here, so a machine
// with no reading stays unknown rather than borrowing another machine's.
export type MachineReading = {
  providers: readonly ProviderRuntime[]
  sessions: readonly Pick<SessionSummary, "id" | "title" | "state">[]
  readAt: string
}

export function machineReading(snapshot: WorkspaceSnapshot, readAt: Date): MachineReading {
  return {
    providers: snapshot.machine.providers,
    sessions: snapshot.sessions.map(({ id, title, state }) => ({ id, title, state })),
    readAt: readAt.toISOString(),
  }
}

export type FleetAccessState =
  | { state: "checking" }
  | { state: "admitted"; deviceId: string; reading: MachineReading }
  | { state: "refused"; message: string }

// What this client knows about a machine's agents and sessions. Sessions are a
// list from a reading, or only a count for the machine in use when the shell
// passed no reading for it. Unknown carries the reason, never a guess.
export type MachineFacts =
  | { known: true; providers: readonly ProviderRuntime[]; sessions: MachineReading["sessions"] | number; readAt?: string; stale: boolean }
  | { known: false; reason: string }

export const readingClock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })

export function asOf(readAt: string | undefined): string | undefined {
  return readAt === undefined ? undefined : `as of ${readingClock.format(new Date(readAt))}`
}

// A machine the home daemon reports as unreachable still shows what it last
// said, dated, because that is what is still true about it. A reading whose
// refresh failed (`unread` holds the readAt it kept) is dated the same way.
export function machineFacts(
  machine: FleetMachine,
  input: {
    readings: Readonly<Record<string, MachineReading>>
    access: FleetAccessState | undefined
    currentMachineId: string
    providers?: readonly ProviderRuntime[] | undefined
    currentSessionCount?: number | undefined
    unread?: ReadonlyMap<string, string> | undefined
  },
): MachineFacts {
  const unreachable = machine.health === "unreachable"
  const reading = input.readings[machine.id] ?? (input.access?.state === "admitted" ? input.access.reading : undefined)
  if (reading) {
    const stale = unreachable || input.unread?.get(machine.id) === reading.readAt
    return { known: true, providers: reading.providers, sessions: reading.sessions, readAt: reading.readAt, stale }
  }
  if (machine.id === input.currentMachineId && input.providers) {
    return { known: true, providers: input.providers, sessions: input.currentSessionCount ?? 0, stale: false }
  }
  if (input.access?.state === "checking") return { known: false, reason: "verifying client access" }
  if (!machine.self) return { known: false, reason: "no client credential here" }
  return { known: false, reason: unreachable ? "daemon unreachable" : "not read yet" }
}

// The agents list's reason, as a clause about that machine.
export function unknownAgentsReason(reason: string): string {
  return reason === "no client credential here" ? "this app holds no client credential for it" : reason
}

export function machineAgents(entries: readonly FleetEntry[], factsOf: (machine: FleetMachine) => MachineFacts): MachineAgents[] {
  return entries.flatMap((entry) => {
    if (entry.kind !== "machine") return []
    const facts = factsOf(entry.machine)
    const base = { machineId: entry.machine.id, label: entry.machine.label }
    return [facts.known
      ? { ...base, providers: facts.providers, stale: facts.stale ? asOf(facts.readAt) : undefined }
      : { ...base, unknown: unknownAgentsReason(facts.reason) }]
  })
}

// Every machine's agents as this client knows them, for Settings: the same
// rows the Machines surface draws.
export function fleetAgents(
  entries: readonly FleetEntry[],
  input: {
    readings: Readonly<Record<string, MachineReading>>
    clientAccess: Readonly<Record<string, FleetAccessState>>
    currentMachineId: string
  },
): MachineAgents[] {
  return machineAgents(entries, (machine) => machineFacts(machine, {
    readings: input.readings, access: input.clientAccess[machine.id], currentMachineId: input.currentMachineId,
  }))
}

type ClientInputs = Omit<Parameters<typeof fleetClient>[0], "access">

// This object lives only for this home connection in this app. Credentials
// never enter storage, fleet snapshots, notifications, URLs or the machine store.
export class FleetAccessSession {
  #states: Readonly<Record<string, FleetAccessState>> = {}
  readonly #access = new Map<string, FleetAccess>()
  readonly #pending = new Map<string, DomovoiClient>()
  readonly #listeners = new Set<() => void>()
  readonly #readers = new Map<string, Set<() => void>>()

  constructor(private readonly inputs: () => ClientInputs) {}
  snapshot = (): Readonly<Record<string, FleetAccessState>> => this.#states
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #set(machineId: string, state?: FleetAccessState): void {
    const next = { ...this.#states }
    if (state) next[machineId] = state
    else delete next[machineId]
    this.#states = next
    for (const listener of this.#listeners) listener()
  }

  async authorize(machineId: string, credential: string, signal: AbortSignal): Promise<void> {
    this.remove(machineId)
    const deadline = Deadline.start(30_000)
    let client: DomovoiClient | undefined
    const cancel = () => { if (client && this.#pending.get(machineId) === client) this.remove(machineId) }
    try {
      if (signal.aborted) return
      if (!credentialSchema.safeParse(credential).success) throw new ClientAdmissionError("client-credential-required")
      client = fleetClient({ ...this.inputs(), access: { machineId, credential } })
      this.#pending.set(machineId, client)
      this.#set(machineId, { state: "checking" })
      signal.addEventListener("abort", cancel, { once: true })
      const snapshot = await client.connect(deadline)
      if (signal.aborted || this.#pending.get(machineId) !== client) return
      if (!client.admittedDeviceId) throw new ClientAdmissionError("verification-unavailable")
      this.#access.set(machineId, { machineId, credential, deviceId: client.admittedDeviceId })
      this.#set(machineId, { state: "admitted", deviceId: client.admittedDeviceId, reading: machineReading(snapshot, new Date()) })
    } catch (cause) {
      if (!signal.aborted && (!client || this.#pending.get(machineId) === client)) {
        const error = fleetAccessError(cause)
        this.#set(machineId, { state: "refused", message: error.message })
        throw error
      }
    } finally {
      signal.removeEventListener("abort", cancel)
      if (client && this.#pending.get(machineId) === client) this.#pending.delete(machineId)
      client?.disconnect()
      deadline.clear()
    }
  }

  access(machineId: string): FleetAccess | undefined { return this.#access.get(machineId) }

  remove(machineId: string): void {
    const client = this.#pending.get(machineId)
    this.#pending.delete(machineId)
    client?.disconnect()
    this.#access.delete(machineId)
    for (const close of this.#readers.get(machineId) ?? []) close()
    this.#readers.delete(machineId)
    this.#set(machineId)
  }

  refuse(machineId: string, message: string): void {
    this.remove(machineId)
    this.#set(machineId, { state: "refused", message })
  }

  retain(machines: readonly FleetMachine[]): void {
    const ids = new Set(machines.filter((machine) => !machine.self).map((machine) => machine.id))
    for (const id of Object.keys(this.#states)) if (!ids.has(id)) this.remove(id)
  }

  clear(): void { for (const id of Object.keys(this.#states)) this.remove(id) }

  // One search on one admitted machine, asked directly (J39). A machine that
  // does not answer within the deadline throws, and the palette shows it as
  // not searched rather than as no results. Identity is checked the way the
  // inventory reader checks it: the answer must come from the machine asked.
  async search(machineId: string, query: string, signal: AbortSignal): Promise<SessionSearchResult> {
    return this.#ask(machineId, signal, "Search cancelled", (client, deadline) =>
      client.searchSessions({ query, limit: 20 }, { deadline, signal }))
  }

  // Reads what an admitted machine reports about its agents and sessions now.
  // A machine that does not answer keeps its last reading, with its time, and
  // the caller says how old it is; only a refused credential withdraws access.
  async read(machineId: string, signal: AbortSignal): Promise<void> {
    await this.#ask(machineId, signal, "Read cancelled", (_client, _deadline, snapshot, access) => {
      this.#set(machineId, { state: "admitted", deviceId: access.deviceId, reading: machineReading(snapshot, new Date()) })
      return Promise.resolve()
    })
  }

  // One question on its own connection with the admitted credential, closed
  // when answered. The answer must come from the device that was admitted.
  async #ask<T>(
    machineId: string,
    signal: AbortSignal,
    cancelled: string,
    question: (client: DomovoiClient, deadline: Deadline, snapshot: WorkspaceSnapshot, access: FleetAccess) => Promise<T>,
  ): Promise<T> {
    const access = this.#access.get(machineId)
    if (!access) throw new ClientAdmissionError("client-credential-required")
    const deadline = Deadline.start(10_000)
    const client = fleetClient({ ...this.inputs(), access })
    const close = () => { client.disconnect(); deadline.clear(); signal.removeEventListener("abort", close); this.#readers.get(machineId)?.delete(close) }
    const readers = this.#readers.get(machineId) ?? new Set<() => void>()
    readers.add(close)
    this.#readers.set(machineId, readers)
    signal.addEventListener("abort", close, { once: true })
    try {
      if (signal.aborted) throw new DOMException(cancelled, "AbortError")
      const snapshot = await client.connect(deadline)
      if (signal.aborted || this.#access.get(machineId) !== access) throw new DOMException(cancelled, "AbortError")
      if (client.admittedDeviceId !== access.deviceId) throw new ClientAdmissionError("identity-mismatch")
      return await question(client, deadline, snapshot, access)
    } catch (cause) {
      if (cause instanceof ClientAdmissionError && !signal.aborted && this.#access.get(machineId) === access) {
        this.refuse(machineId, cause.message)
      }
      throw cause
    } finally {
      close()
    }
  }

  async inventory(machineId: string, signal: AbortSignal): Promise<FleetInventoryReader> {
    // One comparison question, not a persistent reader. The collector closes
    // it in finally. Connect and read share 30 seconds; timeout is not revocation.
    const access = this.#access.get(machineId)
    if (!access) throw new ClientAdmissionError("client-credential-required")
    const deadline = Deadline.start(30_000)
    const client = fleetClient({ ...this.inputs(), access })
    const close = () => { client.disconnect(); deadline.clear(); signal.removeEventListener("abort", close); this.#readers.get(machineId)?.delete(close) }
    const readers = this.#readers.get(machineId) ?? new Set<() => void>()
    readers.add(close)
    this.#readers.set(machineId, readers)
    signal.addEventListener("abort", close, { once: true })
    try {
      if (signal.aborted) throw new DOMException("Inventory cancelled", "AbortError")
      await client.connect(deadline)
      if (signal.aborted || this.#access.get(machineId) !== access) throw new DOMException("Inventory cancelled", "AbortError")
      return { inventory: async () => {
        try {
          const inventory = await client.getSkillInventory({ deadline, signal })
          if (inventory.machine.id !== machineId) throw new ClientAdmissionError("identity-mismatch")
          return inventory
        } catch (cause) {
          if (cause instanceof ClientAdmissionError && !signal.aborted && this.#access.get(machineId) === access) {
            this.refuse(machineId, cause.message)
          }
          throw cause
        }
      }, close }
    } catch (cause) {
      close()
      if (cause instanceof ClientAdmissionError && !signal.aborted && this.#access.get(machineId) === access) this.refuse(machineId, cause.message)
      throw cause
    }
  }
}
