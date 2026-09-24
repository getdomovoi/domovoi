import { describe, expect, it } from "vitest"

import { paletteSearchTargets, pendingElsewhereStep } from "./palette-search-targets"

const home = { id: "machine-home", label: "mac-mini-m4", connection: "local", self: true }
const studio = { id: "machine-studio", label: "studio", connection: "tailnet", self: false }
const wsl = { id: "machine-wsl", label: "wsl-ubuntu-24", connection: "tailnet", self: false }
const admitted = { "machine-studio": { state: "admitted" }, "machine-wsl": { state: "admitted" } } as const

describe("paletteSearchTargets", () => {
  it("searches home as here and every admitted machine as another", () => {
    const targets = paletteSearchTargets({ machines: [home, studio, wsl], access: admitted, homeMachineId: home.id, currentMachineId: home.id, currentLabel: "fallback" })
    expect(targets.here).toEqual({ id: home.id, label: "mac-mini-m4" })
    expect(targets.others.map((machine) => machine.id)).toEqual([studio.id, wsl.id])
  })

  it("bases the list on the attached machine, and counts home among the others", () => {
    const targets = paletteSearchTargets({ machines: [home, studio, wsl], access: admitted, homeMachineId: home.id, currentMachineId: studio.id, currentLabel: "fallback" })
    expect(targets.here).toEqual({ id: studio.id, label: "studio" })
    expect(targets.others.map((machine) => machine.id)).toEqual([home.id, wsl.id])
    expect(targets.others[0]).toEqual({ id: home.id, label: "mac-mini-m4", transport: "local" })
  })

  it("leaves out a machine this client is not admitted to, and names here from the snapshot when the fleet has no entry", () => {
    const targets = paletteSearchTargets({ machines: [studio], access: {}, homeMachineId: home.id, currentMachineId: home.id, currentLabel: "mac-mini-m4" })
    expect(targets.here).toEqual({ id: home.id, label: "mac-mini-m4" })
    expect(targets.others).toEqual([])
  })
})

describe("pendingElsewhereStep", () => {
  const pending = { from: home.id, machineId: studio.id, sessionId: "s-1" }

  it("waits while the window is still on the machine it left from", () => {
    expect(pendingElsewhereStep(pending, { currentMachineId: home.id, snapshotMachineId: home.id, sessionIds: [] })).toBe("wait")
  })

  it("waits for the target machine's snapshot", () => {
    expect(pendingElsewhereStep(pending, { currentMachineId: studio.id, snapshotMachineId: home.id, sessionIds: [] })).toBe("wait")
  })

  it("opens the session once the target's snapshot holds it", () => {
    expect(pendingElsewhereStep(pending, { currentMachineId: studio.id, snapshotMachineId: studio.id, sessionIds: ["s-1"] })).toBe("open")
  })

  it("drops the intent when the session is gone on arrival", () => {
    expect(pendingElsewhereStep(pending, { currentMachineId: studio.id, snapshotMachineId: studio.id, sessionIds: ["s-2"] })).toBe("drop")
  })

  it("drops the intent when the window moved somewhere else", () => {
    expect(pendingElsewhereStep(pending, { currentMachineId: wsl.id, snapshotMachineId: wsl.id, sessionIds: ["s-1"] })).toBe("drop")
  })
})
