import type { HandheldClient } from "./lib/protocol-facts"

// There is no push without the relay, and nothing can wake a phone over a
// tailnet. A gate reaches this device only over the connection the open app
// holds, so the pairing card, Settings and the sessions list all say so.
export const sessionsGateReach = "Keep Domovoi open to answer gates. Nothing is pushed to this phone yet."

export function gateReach(device: HandheldClient): string {
  return `Gates reach this ${device} only while Domovoi is open on it. There are no notifications yet.`
}
