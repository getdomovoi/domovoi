import type { ConnectionFault } from "./lib/connection-fault"

export type ShellState = {
  // "ready" is the only one where a screen draws daemon data. The rest are
  // different reasons for an empty screen, and telling them apart is the whole
  // point: "no sessions" and "never asked" look identical and mean opposite
  // things.
  kind: "restoring" | "unpaired" | "refused" | "reaching" | "ready"
  headline: string
  detail: string
}

export function shellState(input: {
  restoringCredential: boolean
  hasCredential: boolean
  hasSnapshot: boolean
  fault: ConnectionFault | undefined
}): ShellState {
  if (input.hasSnapshot) {
    return { kind: "ready", headline: "", detail: "" }
  }
  if (input.restoringCredential) {
    return {
      kind: "restoring",
      headline: "Looking for a saved daemon",
      detail: "This phone keeps its pairing in the keychain.",
    }
  }
  if (!input.hasCredential) {
    return {
      kind: "unpaired",
      headline: "No daemon paired",
      detail: "Add your daemon address and pairing token in Settings.",
    }
  }
  if (input.fault && !input.fault.retriable) {
    return { kind: "refused", headline: input.fault.headline, detail: input.fault.detail }
  }
  // A credential the phone has not managed to use yet. It has never held a
  // snapshot, so it cannot say the workspace is empty, only that it has not
  // been told what is in it.
  return {
    kind: "reaching",
    headline: "Reaching the daemon",
    detail: input.fault?.detail ?? "Nothing has been received from this daemon yet.",
  }
}
