import { describe, expect, it } from "vitest"

import {
  attachedMachineSwitch,
  beganMachineSwitch,
  failedMachineSwitch,
  homeMachineSwitch,
  type MachineSwitchState,
} from "./machine-switch-state.js"

const target = {
  machineId: `machine-${"b".repeat(32)}`,
  endpoint: "wss://studio.tailnet:47831/rpc",
  credential: "n".repeat(43),
}

const switching: MachineSwitchState = beganMachineSwitch(homeMachineSwitch, target.machineId)

describe("machine switch state", () => {
  it("starts on the machine this client is attached to", () => {
    expect(homeMachineSwitch).toEqual({ state: "home" })
  })

  it("remembers which machine is being switched to", () => {
    expect(switching).toEqual({ state: "switching", machineId: target.machineId })
  })

  it("attaches to the machine that answered", () => {
    expect(attachedMachineSwitch(switching, target)).toEqual({ state: "attached", target })
  })

  it("keeps the reason a switch failed", () => {
    expect(failedMachineSwitch(switching, "That machine cannot be reached"))
      .toEqual({ state: "failed", machineId: target.machineId, reason: "That machine cannot be reached" })
  })

  it("ignores an answer for a machine no longer being switched to", () => {
    const later = beganMachineSwitch(switching, `machine-${"c".repeat(32)}`)

    expect(attachedMachineSwitch(later, target)).toBe(later)
    expect(failedMachineSwitch(later, "That machine cannot be reached", target.machineId)).toBe(later)
  })

  it("ignores an answer that arrives after the client went home", () => {
    expect(attachedMachineSwitch(homeMachineSwitch, target)).toBe(homeMachineSwitch)
  })

  it("returns home from a machine it had attached to", () => {
    const attached = attachedMachineSwitch(switching, target)

    expect(beganMachineSwitch(attached, target.machineId))
      .toEqual({ state: "switching", machineId: target.machineId })
  })
})
