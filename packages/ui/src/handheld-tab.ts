import { createContext, useContext } from "react"

// A phone or tablet credential may call only phoneAndTabletRpcMethods. The
// daemon answers anything else from it with the authentication error, before
// it reads the parameters (server.ts), and the client closes its connection on
// that code (client.ts), so one press of such a control drops the tab. The
// shell provides the name of the machine a phone or tablet tab is connected
// to, and undefined in a desktop or web tab; a surface whose controls send one
// of those requests reads it, locks them and says why.
export const HandheldTabMachine = createContext<string | undefined>(undefined)

export function useHandheldTabMachine(): string | undefined {
  return useContext(HandheldTabMachine)
}

// Q88, in the form of Q71: what is off, why, and where it can be done.
export function offInHandheldTab(controls: readonly string[], refused: string, machine: string): string {
  const last = controls.at(-1) ?? ""
  const named = controls.length > 1 ? `${controls.slice(0, -1).join(", ")} and ${last}` : last
  return `${named} ${controls.length > 1 ? "are" : "is"} off in a phone or tablet tab: the daemon does not ${refused} for a phone or tablet credential. Use the desktop app on ${machine}.`
}
