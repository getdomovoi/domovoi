import { credentialSchema, type FleetMachine } from "@getdomovoi/protocol"

import type { DomovoiClient } from "./client.js"
import { ClientAdmissionError } from "./client-admission-policy.js"
import { Deadline } from "./deadline.js"
import { fleetAccessError, fleetClient, type FleetAccess } from "./fleet-access.js"
import type { FleetInventoryReader } from "./fleet-inventories.js"

export type FleetAccessState =
  | { state: "checking" }
  | { state: "admitted"; deviceId: string }
  | { state: "refused"; message: string }

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
      await client.connect(deadline)
      if (signal.aborted || this.#pending.get(machineId) !== client) return
      if (!client.admittedDeviceId) throw new ClientAdmissionError("verification-unavailable")
      this.#access.set(machineId, { machineId, credential, deviceId: client.admittedDeviceId })
      this.#set(machineId, { state: "admitted", deviceId: client.admittedDeviceId })
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
