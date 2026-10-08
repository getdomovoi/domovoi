import { useEffect, useRef } from "react"
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
  // `unanswered` marks a reading the machine did not answer a later read of.
  | { state: "admitted"; deviceId: string; reading: MachineReading; unanswered?: true }
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

// The home daemon is not hearing from these machines now, so what they last
// said is dated rather than shown as current.
const silentHealth: ReadonlySet<FleetMachine["health"]> = new Set(["unreachable", "reconnecting", "degraded"])

// A snapshot the shell holds for a machine: its own home daemon, or the
// machine it is attached to. Live while that connection is open; a closed
// connection leaves the last snapshot, which is only what the machine said then.
export type HeldReading = { reading: MachineReading; live: boolean }

// A machine that is not answering still shows what it last said, dated,
// because that is what is still true about it: one the home daemon is not
// hearing from, one that did not answer this client's last read, or one whose
// held connection closed.
export function machineFacts(
  machine: FleetMachine,
  input: {
    readings: Readonly<Record<string, HeldReading>>
    access: FleetAccessState | undefined
    currentMachineId: string
    providers?: readonly ProviderRuntime[] | undefined
    currentSessionCount?: number | undefined
  },
): MachineFacts {
  const unreachable = machine.health === "unreachable"
  const admitted = input.access?.state === "admitted" ? input.access : undefined
  const held = input.readings[machine.id]
  // An open connection is the current answer. Otherwise the newer of a kept
  // snapshot and the admission's own reading.
  const useHeld = held !== undefined && (held.live || !admitted || Date.parse(held.reading.readAt) >= Date.parse(admitted.reading.readAt))
  const reading = useHeld ? held.reading : admitted?.reading
  if (reading) {
    const stale = useHeld
      ? !held.live || unreachable
      : silentHealth.has(machine.health) || admitted?.unanswered === true
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
    readings: Readonly<Record<string, HeldReading>>
    clientAccess: Readonly<Record<string, FleetAccessState>>
    currentMachineId: string
  },
): MachineAgents[] {
  return machineAgents(entries, (machine) => machineFacts(machine, {
    readings: input.readings, access: input.clientAccess[machine.id], currentMachineId: input.currentMachineId,
  }))
}

// A reading younger than this is not read again when a visit starts: the
// machine was just admitted or just read.
const freshReadingMs = 30_000

// Each admitted machine is read once per visit of a surface that shows its
// facts (Machines, Settings), or when it is admitted during one, unless its
// reading is fresh: one connection per machine per visit, not a poll. A
// machine that does not answer keeps its last reading, marked unanswered in
// `clientAccess`, and the surface dates it. A visit is while `active` holds
// and the caller stays mounted.
export function useReadOnVisit({ active, connected, clientAccess, onReadMachine }: {
  active: boolean
  connected: boolean
  clientAccess: Readonly<Record<string, FleetAccessState>>
  onReadMachine?: ((machineId: string, signal: AbortSignal) => Promise<void>) | undefined
}): void {
  const admittedIds = Object.entries(clientAccess)
    .filter(([, access]) => access.state === "admitted")
    .map(([machineId]) => machineId)
    .sort()
    .join(" ")
  const requested = useRef(new Set<string>())
  const pending = useRef(new Map<string, AbortController>())
  // Ending the visit cancels the reads still waiting, and the next visit asks
  // every machine again. A read cut short was never answered, so a remount
  // (StrictMode does one in development) asks again too.
  useEffect(() => {
    if (!active) return
    const asked = requested.current
    const waiting = pending.current
    return () => {
      for (const read of waiting.values()) read.abort()
      waiting.clear()
      asked.clear()
    }
  }, [active])
  useEffect(() => {
    if (!active || !onReadMachine || !connected) return
    for (const machineId of admittedIds.split(" ").filter(Boolean)) {
      const access = clientAccess[machineId]
      if (requested.current.has(machineId) || access?.state !== "admitted") continue
      requested.current.add(machineId)
      if (Date.now() - Date.parse(access.reading.readAt) < freshReadingMs) continue
      const read = new AbortController()
      pending.current.set(machineId, read)
      // The answer, or the lack of one, arrives through clientAccess.
      onReadMachine(machineId, read.signal).catch(() => {}).finally(() => {
        if (pending.current.get(machineId) === read) pending.current.delete(machineId)
      })
    }
    // The ids name the machines to read; a new reading of one must not read it
    // again, so clientAccess and onReadMachine are left out of the dependencies.
  }, [admittedIds, connected, active])
}

type ClientInputs = Omit<Parameters<typeof fleetClient>[0], "access">

// The refusals that say this client's credential or the machine's identity is
// no longer good, as opposed to a machine that is down or out of route.
const credentialRefusals: ReadonlySet<ClientAdmissionError["reason"]> = new Set([
  "client-credential-required",
  "identity-mismatch",
  "not-enrolled",
])

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
    return this.#ask(machineId, signal, "Search cancelled", () => true, (client, deadline) =>
      client.searchSessions({ query, limit: 20 }, { deadline, signal }))
  }

  // Reads what an admitted machine reports about its agents and sessions now.
  // Machines asks this on its own each time it opens, so a machine that is
  // down or has no route keeps its access and its last reading, which the
  // caller dates. Only an answer that refuses this credential or this
  // identity, or a machine no longer enrolled, withdraws access.
  async read(machineId: string, signal: AbortSignal): Promise<void> {
    const before = this.#states[machineId]
    try {
      await this.#ask(machineId, signal, "Read cancelled", (reason) => credentialRefusals.has(reason), (_client, _deadline, snapshot, access) => {
        this.#set(machineId, { state: "admitted", deviceId: access.deviceId, reading: machineReading(snapshot, new Date()) })
        return Promise.resolve()
      })
    } catch (cause) {
      // Still the admission this read started from, so its reading is the
      // one that went unanswered. A refusal or a new admission replaced it.
      const current = this.#states[machineId]
      if (!signal.aborted && current === before && current?.state === "admitted") this.#set(machineId, { ...current, unanswered: true })
      throw cause
    }
  }

  // One question on its own connection with the admitted credential, closed
  // when answered. The answer must come from the device that was admitted.
  // `withdraws` says which admission refusals end this client's access.
  async #ask<T>(
    machineId: string,
    signal: AbortSignal,
    cancelled: string,
    withdraws: (reason: ClientAdmissionError["reason"]) => boolean,
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
      if (cause instanceof ClientAdmissionError && withdraws(cause.reason) && !signal.aborted && this.#access.get(machineId) === access) {
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
