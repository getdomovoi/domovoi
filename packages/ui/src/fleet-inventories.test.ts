import { describe, expect, it, vi } from "vitest"

import type { FleetMachine, SkillInventory } from "@getdomovoi/protocol"

import {
  collectFleetInventories,
  defaultFleetInventoryConcurrency,
  fleetInventoryTargets,
  inventoryMachineFor,
} from "./fleet-inventories.js"
import { MachineOpenError } from "./open-machine.js"

function machine(overrides: Partial<FleetMachine> = {}): FleetMachine {
  return {
    id: "machine-hetzner",
    label: "hetzner-cx42",
    platform: "linux",
    arch: "x64",
    version: "0.1.0",
    connection: "lan",
    capabilities: ["sessions", "skills"],
    protocolVersion: "0.1.0",
    transports: [{ kind: "lan", endpoint: "wss://10.0.0.4:47831/rpc" }],
    heartbeat: { state: "online", lastSeenAt: new Date().toISOString() },
    health: "online",
    self: false,
    ...overrides,
  } as FleetMachine
}

function inventory(name: string): SkillInventory {
  return {
    machine: { id: `machine-${name}`, name, platform: "linux", arch: "x64", version: "0.1.0" },
    skills: [],
  }
}

const local = inventory("studio-arch")

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const settle = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe("fleetInventoryTargets", () => {
  it("skips this machine and any machine that does not run skills", () => {
    const targets = fleetInventoryTargets([
      machine({ id: "machine-self", self: true }),
      machine({ id: "machine-terminals", capabilities: ["terminals"] }),
      machine({ id: "machine-hetzner" }),
    ])
    expect(targets.map((candidate) => candidate.id)).toEqual(["machine-hetzner"])
  })

  it("treats an unknown fleet as no fleet", () => {
    expect(fleetInventoryTargets(null)).toEqual([])
  })
})

describe("inventoryMachineFor", () => {
  it("carries the machine's own facts and renames its label", () => {
    expect(inventoryMachineFor(machine())).toEqual({
      id: "machine-hetzner",
      name: "hetzner-cx42",
      platform: "linux",
      arch: "x64",
      version: "0.1.0",
    })
  })
})

describe("collectFleetInventories", () => {
  it("keeps this machine first and adds one source per reachable member", async () => {
    const remote = inventory("hetzner-cx42")
    const sources = await collectFleetInventories({
      local,
      fleet: [machine({ id: "machine-self", self: true }), machine()],
      open: async () => ({ inventory: async () => remote, close: () => {} }),
    })
    expect(sources).toEqual([
      { state: "available", inventory: local },
      { state: "available", inventory: remote },
    ])
  })

  it("asks each member only for metadata and closes the connection it opened", async () => {
    const close = vi.fn()
    const reader = { inventory: vi.fn(async () => inventory("hetzner-cx42")), close }
    await collectFleetInventories({ local, fleet: [machine()], open: async () => reader })
    expect(reader.inventory).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("closes the connection even when the inventory call fails", async () => {
    const close = vi.fn()
    const sources = await collectFleetInventories({
      local,
      fleet: [machine()],
      open: async () => ({
        inventory: async () => { throw new Error("timed out") },
        close,
      }),
    })
    expect(close).toHaveBeenCalledOnce()
    expect(sources[1]).toEqual({ state: "unknown", machine: inventoryMachineFor(machine()) })
  })

  it("reports a machine that could not be opened as unreachable", async () => {
    const sources = await collectFleetInventories({
      local,
      fleet: [machine()],
      open: async () => { throw new MachineOpenError("That machine has to be paired again") },
    })
    expect(sources[1]).toEqual({ state: "unreachable", machine: inventoryMachineFor(machine()) })
  })

  it("never dials a machine the switcher would refuse", async () => {
    const open = vi.fn()
    const sources = await collectFleetInventories({
      local,
      fleet: [machine({ health: "upgrade-required" })],
      open,
    })
    expect(open).not.toHaveBeenCalled()
    expect(sources[1]).toMatchObject({ state: "unreachable" })
  })

  it("reports every member even when one of them fails", async () => {
    const sources = await collectFleetInventories({
      local,
      fleet: [
        machine({ id: "machine-a", label: "alpha" }),
        machine({ id: "machine-b", label: "beta" }),
      ],
      open: async (candidate) => {
        if (candidate.id === "machine-a") throw new MachineOpenError("unreachable")
        return { inventory: async () => inventory("beta"), close: () => {} }
      },
    })
    expect(sources.map((source) => source.state)).toEqual(["available", "unreachable", "available"])
  })

  it("returns only this machine when nothing else runs skills", async () => {
    const open = vi.fn()
    await expect(collectFleetInventories({ local, fleet: null, open })).resolves.toEqual([
      { state: "available", inventory: local },
    ])
    expect(open).not.toHaveBeenCalled()
  })

  it("dials only a few machines at a time and reports every one of them", async () => {
    const fleet = Array.from({ length: 6 }, (_, index) =>
      machine({ id: `machine-${index}`, label: `member-${index}` }))
    const answers: Array<ReturnType<typeof deferred<SkillInventory>>> = []
    let inFlight = 0
    let peak = 0
    const collecting = collectFleetInventories({
      local,
      fleet,
      open: async (candidate) => {
        const answer = deferred<SkillInventory>()
        answers.push(answer)
        inFlight += 1
        peak = Math.max(peak, inFlight)
        return {
          inventory: () => answer.promise,
          close: () => { inFlight -= 1 },
        }
      },
    })
    await settle()
    expect(answers).toHaveLength(defaultFleetInventoryConcurrency)
    expect(defaultFleetInventoryConcurrency).toBeLessThan(fleet.length)

    for (let index = 0; index < defaultFleetInventoryConcurrency; index += 1) {
      answers[index]!.resolve(inventory(`member-${index}`))
    }
    await settle()
    expect(answers).toHaveLength(fleet.length)
    for (let index = defaultFleetInventoryConcurrency; index < fleet.length; index += 1) {
      answers[index]!.resolve(inventory(`member-${index}`))
    }

    const sources = await collecting
    expect(peak).toBe(defaultFleetInventoryConcurrency)
    expect(sources.map((source) => source.state)).toEqual(Array(fleet.length + 1).fill("available"))
  })

  it("asks online machines before ones that are still reconnecting", async () => {
    const dialed: string[] = []
    const sources = await collectFleetInventories({
      local,
      fleet: [
        machine({ id: "machine-a", label: "alpha", health: "reconnecting" }),
        machine({ id: "machine-b", label: "beta" }),
        machine({ id: "machine-c", label: "gamma", health: "reconnecting" }),
        machine({ id: "machine-d", label: "delta" }),
      ],
      concurrency: 1,
      open: async (candidate) => {
        dialed.push(candidate.id)
        return { inventory: async () => inventory(candidate.label), close: () => {} }
      },
    })
    expect(dialed).toEqual(["machine-b", "machine-d", "machine-a", "machine-c"])
    expect(sources.slice(1).map((source) => (
      source.state === "available" ? source.inventory.machine.name : source.state
    ))).toEqual(["alpha", "beta", "gamma", "delta"])
  })

  it("stops dialing once the refresh is cancelled and hands the dial the same signal", async () => {
    const controller = new AbortController()
    const close = vi.fn()
    const answer = deferred<SkillInventory>()
    const open = vi.fn(async (_candidate: FleetMachine, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false)
      return { inventory: () => answer.promise, close }
    })
    const collecting = collectFleetInventories({
      local,
      fleet: [
        machine({ id: "machine-a", label: "alpha" }),
        machine({ id: "machine-b", label: "beta" }),
      ],
      concurrency: 1,
      signal: controller.signal,
      open,
    })
    const outcome = collecting.catch((cause: unknown) => cause)
    await settle()
    expect(open).toHaveBeenCalledOnce()

    controller.abort()
    answer.resolve(inventory("alpha"))
    await expect(outcome).resolves.toMatchObject({ name: "AbortError" })
    expect(open).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(open.mock.calls[0]![1].aborted).toBe(true)
  })

  it("refuses a concurrency that is not a positive whole number", async () => {
    for (const concurrency of [0, 1.5, -1, Number.NaN]) {
      await expect(collectFleetInventories({
        local,
        fleet: [machine()],
        concurrency,
        open: async () => { throw new Error("must not dial") },
      })).rejects.toBeInstanceOf(RangeError)
    }
  })
})
