import type { FleetEntry, FleetMachine, FleetPendingOperation } from "@getdomovoi/protocol"

// Only a machine entry carries facts a comparison or a dial can use; a pending
// or unenrolled entry has an identity and nothing else, and guessing facts for
// it would be a claim. Each kind returns, so a fourth kind fails to compile.
function entryMachines(entry: FleetEntry): FleetMachine[] {
  switch (entry.kind) {
    case "machine":
      return [entry.machine]
    case "pending":
      return []
    case "unenrolled":
      return []
  }
}

// The fleet is one list of lifecycle entries; this is the slice of it that
// has an authenticated descriptor.
export function fleetMachines(entries: readonly FleetEntry[]): FleetMachine[] {
  return entries.flatMap(entryMachines)
}

// Where a session can be moved to. A move lands on a daemon, so only a machine
// entry names one, and the machine it is already on is not a destination.
// Every surface offering a move derives from this: two of them restating the
// rule would drift, and the launcher and the composer must agree about what is
// transferable.
export function transferTargets({
  entries,
  transferEntries,
  currentMachineId,
}: {
  entries: readonly FleetEntry[]
  transferEntries?: readonly FleetEntry[] | undefined
  currentMachineId: string
}): FleetMachine[] {
  return fleetMachines(transferEntries ?? entries).filter((machine) => machine.id !== currentMachineId)
}

export function shortMachineId(machineId: string): string {
  return `${machineId.slice(0, 16)}…`
}

// A pending row reads as what the daemon is doing. There is no button because
// the daemon resumes the operation itself; a client cannot.
export const pendingOperationWord: Record<FleetPendingOperation["operation"], string> = {
  enroll: "Enrolling",
  forget: "Forgetting",
}

export const pendingOperationNote = "This daemon resumes it on its own"

// A legacy keyring entry: the credential exists, but no enrollment ever
// recorded the machine, so nothing here can describe or reach it.
export const unenrolledNote = "A credential exists but this machine was never enrolled. Pair it again to enroll it."
