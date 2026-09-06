import { DomovoiClient } from "@/client"
import { Deadline } from "@/deadline"

import type { DesktopStartup } from "./desktop-startup.js"

// Every phase below waits on one process. The daemon this smoke owns serves its
// listener from the Electron main process that launched this renderer, and the
// endpoint is published only after that listener accepts, so no phase races the
// daemon into existence. What it races is the machine: a cold CI runner stalls
// the process holding the listener for many seconds while it is already
// listening, and a stalled peer is waited out, not dialed again. device.pair
// and device.revoke are mutations that must not be reissued, so every budget
// covers the stall rather than the happy path. A Windows runner took a bare
// process spawn past ten seconds in the same window a dial here failed, so a
// five second phase was a fixed window rather than a bound. The total still
// stops a real hang well inside the launch budget the parent process enforces.
const totalBudgetMs = 30_000
const connectBudgetMs = 20_000
const requestBudgetMs = 20_000

// A bare "Timed out after 5000ms during open" leaves the next reader guessing
// which part of the smoke was waiting and how much of the one clock it had.
async function during<T>(step: string, deadline: Deadline, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `while ${step}, ${deadline.remainingMs()}ms left of its ${deadline.budgetMs}ms budget: ${reason}`,
      { cause },
    )
  }
}

// This is the real browser client, not a main-process test socket. IPC, CSP,
// authentication, schema parsing and the persistent device store must all work.
export async function verifyLaunchSmokeDaemon(startup: DesktopStartup): Promise<void> {
  if (startup.kind !== "workspace") throw new Error(startup.message)
  if (startup.daemon.kind !== "owned") throw new Error("Smoke must own its isolated daemon")
  const deadline = Deadline.start(totalBudgetMs)
  const budgets = { connectMs: connectBudgetMs, requestMs: requestBudgetMs }
  let root: DomovoiClient | undefined
  let paired: DomovoiClient | undefined
  try {
    const rootClient = new DomovoiClient(startup.rpcUrl, "desktop", { budgets, authToken: startup.rpcToken })
    root = rootClient
    const workspace = await during("opening the first connection to the daemon it started", deadline,
      () => rootClient.connect(deadline))
    const pairing = await during("pairing a device", deadline,
      () => rootClient.request("device.pair", { label: "Desktop launch smoke", client: "desktop" }, { deadline }))
    const pairedClient = new DomovoiClient(startup.rpcUrl, "desktop", { budgets, authToken: pairing.token })
    paired = pairedClient
    const authenticated = await during("connecting as the paired device", deadline,
      () => pairedClient.connect(deadline))
    if (authenticated.machine.id !== workspace.machine.id) throw new Error("Smoke paired with a different daemon")
    await during("reading the workspace as the paired device", deadline,
      () => pairedClient.request("workspace.get", {}, { deadline }))
    await during("revoking the paired device", deadline,
      () => rootClient.revokeDevice({ deviceId: pairing.device.id }, { deadline }))
    const listed = await during("listing devices after revocation", deadline,
      () => rootClient.listDevices({ deadline }))
    const device = listed.devices.find((entry) => entry.id === pairing.device.id)
    if (!device?.revokedAt || !device.lastSeenAt) throw new Error("Smoke pairing was not authenticated and revoked")
    if (deadline.remainingMs() === 0) throw new Error("Smoke daemon verification exceeded its deadline")
  } finally {
    paired?.disconnect()
    root?.disconnect()
    deadline.clear()
  }
}
