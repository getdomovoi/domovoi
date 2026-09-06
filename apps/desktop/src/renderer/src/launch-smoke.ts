import { DomovoiClient } from "@/client"
import { Deadline } from "@/deadline"

import type { DesktopStartup } from "./desktop-startup.js"

// This is the real browser client, not a main-process test socket. IPC, CSP,
// authentication, schema parsing and the persistent device store must all work.
export async function verifyLaunchSmokeDaemon(startup: DesktopStartup): Promise<void> {
  if (startup.kind !== "workspace") throw new Error(startup.message)
  if (startup.daemon.kind !== "owned") throw new Error("Smoke must own its isolated daemon")
  const deadline = Deadline.start(15_000)
  const budgets = { connectMs: 5_000, requestMs: 5_000 }
  let root: DomovoiClient | undefined
  let paired: DomovoiClient | undefined
  try {
    root = new DomovoiClient(startup.rpcUrl, "desktop", { budgets, authToken: startup.rpcToken })
    const workspace = await root.connect(deadline)
    const pairing = await root.request("device.pair", { label: "Desktop launch smoke", client: "desktop" }, { deadline })
    paired = new DomovoiClient(startup.rpcUrl, "desktop", { budgets, authToken: pairing.token })
    const authenticated = await paired.connect(deadline)
    if (authenticated.machine.id !== workspace.machine.id) throw new Error("Smoke paired with a different daemon")
    await paired.request("workspace.get", {}, { deadline })
    await root.revokeDevice({ deviceId: pairing.device.id }, { deadline })
    const listed = await root.listDevices({ deadline })
    const device = listed.devices.find((entry) => entry.id === pairing.device.id)
    if (!device?.revokedAt || !device.lastSeenAt) throw new Error("Smoke pairing was not authenticated and revoked")
    if (deadline.remainingMs() === 0) throw new Error("Smoke daemon verification exceeded its deadline")
  } finally {
    paired?.disconnect()
    root?.disconnect()
    deadline.clear()
  }
}
