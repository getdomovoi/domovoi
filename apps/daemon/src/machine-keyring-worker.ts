import { parentPort } from "node:worker_threads"

import { MachineCredentialStore, NativeMachineKeyring } from "./machine-credentials.js"

if (!parentPort) throw new Error("The keyring worker needs its private parent port")
const port = parentPort

type Request =
  | { kind: "save"; machineId: string; credential: string }
  | { kind: "forMachine" | "forget"; machineId: string }
  | { kind: "machines" }

port.on("message", ({ id, request, cancelled, expiresAt }: {
  id: number; request: Request; cancelled: SharedArrayBuffer; expiresAt: bigint
}) => {
  const flag = new Int32Array(cancelled)
  const checkpoint = () => {
    if (Atomics.load(flag, 0) !== 0 || process.hrtime.bigint() >= expiresAt) throw new Error("Keyring operation expired")
  }
  try {
    checkpoint()
    const store = new MachineCredentialStore(new NativeMachineKeyring(checkpoint))
    const result = request.kind === "save" ? store.save(request.machineId, request.credential)
      : request.kind === "forget" ? store.forget(request.machineId)
        : request.kind === "forMachine" ? store.forMachine(request.machineId) : store.machines()
    checkpoint()
    port.postMessage({ id, ok: true, result })
  } catch {
    // Neither native messages nor keychain bytes appear in failure replies.
    port.postMessage({ id, ok: false })
  }
})
