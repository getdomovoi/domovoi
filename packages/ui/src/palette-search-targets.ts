// Which machines the palette searches (J39, review 2026-09-23). The list is
// based on the window's current machine: that one is "here", and every other
// machine this client can ask is searched as another, home included when a
// remote machine is attached. Home is asked on its own connection; the rest
// need an admitted client credential.

type Machine = { id: string; label: string; connection: string }

export type PaletteSearchTargets = {
  here: { id: string; label: string }
  others: { id: string; label: string; transport: string }[]
}

export function paletteSearchTargets({ machines, access, homeMachineId, currentMachineId, currentLabel }: {
  machines: readonly Machine[]
  access: Readonly<Record<string, { state: string } | undefined>>
  homeMachineId: string | null
  currentMachineId: string
  currentLabel: string
}): PaletteSearchTargets {
  const here = machines.find((machine) => machine.id === currentMachineId)
  return {
    here: { id: currentMachineId, label: here?.label ?? currentLabel },
    others: machines
      .filter((machine) => machine.id !== currentMachineId && (machine.id === homeMachineId || access[machine.id]?.state === "admitted"))
      .map((machine) => ({ id: machine.id, label: machine.label, transport: machine.connection })),
  }
}

// A row picked on another machine switches the window there, then opens the
// session once that machine's snapshot arrives. The intent is dropped when the
// session is gone on arrival or the window went somewhere else.
export type PendingElsewhere = { from: string; machineId: string; sessionId: string }

export function pendingElsewhereStep(pending: PendingElsewhere, now: {
  currentMachineId: string | null
  snapshotMachineId: string | null
  sessionIds: readonly string[]
}): "wait" | "open" | "drop" {
  if (now.currentMachineId === pending.from) return "wait"
  if (now.currentMachineId !== pending.machineId) return "drop"
  if (now.snapshotMachineId !== pending.machineId) return "wait"
  return now.sessionIds.includes(pending.sessionId) ? "open" : "drop"
}
