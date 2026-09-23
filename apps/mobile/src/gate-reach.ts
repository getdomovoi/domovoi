import type { HandheldClient } from "./lib/protocol-facts"

// There is no push without the relay, and nothing can wake a phone over a
// tailnet. A gate reaches this device only over the connection the open app
// holds, so the pairing card, Settings and the sessions list all say so.
export const sessionsGateReach = "Keep Domovoi open to answer gates. Nothing is pushed to this phone yet."

// Written out per device rather than templated, so each line the design
// draws is a literal the conformance gate can find.
const gateReachLines: Record<HandheldClient, string> = {
  phone: "Gates reach this phone only while Domovoi is open on it. There are no notifications yet.",
  tablet: "Gates reach this tablet only while Domovoi is open on it. There are no notifications yet.",
}

export function gateReach(device: HandheldClient): string {
  return gateReachLines[device]
}
