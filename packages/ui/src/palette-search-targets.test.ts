import { describe, expect, it } from "vitest"

import { advancePendingElsewhere, paletteSearchTargets } from "./palette-search-targets"

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

describe("advancePendingElsewhere", () => {
  const pending = { from: home.id, machineId: studio.id, sessionId: "s-1", reached: false }
  const at = (currentMachineId: string, snapshotMachineId: string | null, sessionIds: string[] = []) => ({ currentMachineId, snapshotMachineId, sessionIds })

  it("waits while the window is still on the machine it left from", () => {
    expect(advancePendingElsewhere(pending, at(home.id, home.id))).toEqual({ next: pending })
  })

  it("marks the target reached while its snapshot is on the way", () => {
    expect(advancePendingElsewhere(pending, at(studio.id, home.id))).toEqual({ next: { ...pending, reached: true } })
  })

  it("opens the session once the target's snapshot holds it", () => {
    expect(advancePendingElsewhere(pending, at(studio.id, studio.id, ["s-1"]))).toEqual({ next: null, open: "s-1" })
  })

  it("drops the intent when the session is gone on arrival", () => {
    expect(advancePendingElsewhere(pending, at(studio.id, studio.id, ["s-2"]))).toEqual({ next: null })
  })

  it("drops the intent when the window moved somewhere else", () => {
    expect(advancePendingElsewhere(pending, at(wsl.id, wsl.id, ["s-1"]))).toEqual({ next: null })
  })

  // Review 2026-09-23: a switch that reached the target and was then refused
  // returns the window to where it came from. The pick is over; a later
  // manual switch to that machine must not open the session.
  it("drops the intent when the window returns to where it came from", () => {
    const reached = advancePendingElsewhere(pending, at(studio.id, null)).next!
    expect(advancePendingElsewhere(reached, at(home.id, home.id))).toEqual({ next: null })
  })
})
