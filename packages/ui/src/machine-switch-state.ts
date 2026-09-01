import type { MachineTarget } from "./machine-target.js"

export type MachineSwitchState =
  | { state: "home" }
  | { state: "switching"; machineId: string }
  | { state: "attached"; target: MachineTarget }
  | { state: "failed"; machineId: string; reason: string }

export const homeMachineSwitch: MachineSwitchState = { state: "home" }

export function beganMachineSwitch(
  _current: MachineSwitchState,
  machineId: string,
  homeMachineId?: string,
): MachineSwitchState {
  // Selecting the machine this client is already attached through is not a
  // dial: it is going back to the connection it started with.
  if (homeMachineId !== undefined && machineId === homeMachineId) return homeMachineSwitch
  return { state: "switching", machineId }
}

// A dial can take a while, so a slower answer must never land on a machine the
// client has since stopped switching to.
function awaiting(current: MachineSwitchState, machineId: string): boolean {
  return current.state === "switching" && current.machineId === machineId
}

export function attachedMachineSwitch(
  current: MachineSwitchState,
  target: MachineTarget,
): MachineSwitchState {
  if (!awaiting(current, target.machineId)) return current
  return { state: "attached", target }
}

export function failedMachineSwitch(
  current: MachineSwitchState,
  reason: string,
  machineId?: string,
): MachineSwitchState {
  if (current.state !== "switching") return current
  if (machineId !== undefined && current.machineId !== machineId) return current
  return { state: "failed", machineId: current.machineId, reason }
}
