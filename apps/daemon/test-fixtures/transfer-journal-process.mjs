import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"

const [root, pausedPath] = process.argv.slice(2)
const watchdog = setTimeout(() => process.exit(1), 60_000)
process.on("disconnect", () => process.exit(1))
let resume
const released = new Promise((resolve) => { resume = resolve })
process.on("message", (message) => { if (message === "release") resume() })

// Hold an actual chunk descriptor across an IPC rendezvous. All reads,
// publication and removal use the host filesystem; no EPERM is synthesized.
const readFile = fs.readFile
let paused = false
fs.readFile = async (path, options) => {
  if (path !== pausedPath || paused) return readFile(path, options)
  paused = true
  const handle = await fs.open(path, "r")
  try {
    process.send({ state: "chunk-open", pid: process.pid })
    await released
    return await handle.readFile(options)
  } finally {
    await handle.close()
  }
}
syncBuiltinESMExports()

const { createEmptyWorkspace, demoWorkspace } = await import("@getdomovoi/protocol")
const { DomovoiDaemon } = await import("../src/server.ts")
const { SqliteWorkspaceStore } = await import("../src/store.ts")
const { FileTransferTransactions } = await import("../src/transfer-transactions.ts")
const targetMachineId = `machine-${"c".repeat(32)}`
const store = new SqliteWorkspaceStore(":memory:", createEmptyWorkspace({
  ...demoWorkspace.machine, id: targetMachineId,
}))
const credential = store.devices.pair({
  label: "source", binding: { kind: "machine", machineId: `machine-${"b".repeat(32)}` },
}).token
const daemon = new DomovoiDaemon({
  port: 0, store, statePath: join(root, `process-${process.pid}`, "state.sqlite"),
  transferTransactions: new FileTransferTransactions(root),
  outgoingTransferTransactions: new FileTransferTransactions(join(root, `outgoing-${process.pid}`)),
  providerProbe: { inspect: async () => [] },
})
process.on("message", async (message) => {
  if (message !== "stop") return
  try {
    await daemon.stop()
    clearTimeout(watchdog)
    process.disconnect()
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
})
const address = await daemon.start()
process.send({ state: "ready", pid: process.pid, endpoint: `ws://${address.host}:${address.port}/rpc`, credential })
