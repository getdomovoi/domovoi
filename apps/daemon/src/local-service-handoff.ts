import { serviceHandoffRefusal, workspaceSnapshotSchema } from "@getdomovoi/protocol"

import { callDaemonOnce } from "./cli-rpc.js"
import { OperationDeadline } from "./operation-deadline.js"

// J24 (2026-09-23): the desktop main process refuses a switch to or from the
// login service while a turn runs or a gate waits. It reads the workspace
// from its own daemon endpoint and applies the renderer's check to it, so a
// renderer that skipped its own check cannot stop the daemon under that work.
// A workspace that cannot be read throws: not knowing is not a yes.
export async function readLocalServiceHandoffRefusal(input: {
  endpoint: { url: string; token: string }
  timeoutMs: number
}): Promise<string | undefined> {
  const url = new URL(input.endpoint.url)
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/rpc") {
    throw new Error("The daemon endpoint is not a local RPC address")
  }
  const deadline = OperationDeadline.start(input.timeoutMs)
  try {
    const snapshot = workspaceSnapshotSchema.parse(await callDaemonOnce({
      target: { host: url.hostname, port: Number(url.port || (url.protocol === "wss:" ? 443 : 80)),
        ...(url.protocol === "wss:" ? { tls: true } : {}) },
      token: input.endpoint.token, method: "workspace.get", params: {}, deadline,
    }))
    deadline.throwIfExpired()
    return serviceHandoffRefusal(snapshot)
  } finally {
    deadline.clear()
  }
}
