import { rpcMethods, serviceHandoffRefusal, workspaceSnapshotSchema } from "@getdomovoi/protocol"

import { callDaemonHeld, callDaemonOnce, type CliRpcTarget } from "./cli-rpc.js"
import { OperationDeadline } from "./operation-deadline.js"

function localTarget(endpoint: { url: string }): CliRpcTarget {
  const url = new URL(endpoint.url)
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/rpc") {
    throw new Error("The daemon endpoint is not a local RPC address")
  }
  return {
    host: url.hostname, port: Number(url.port || (url.protocol === "wss:" ? 443 : 80)),
    ...(url.protocol === "wss:" ? { tls: true } : {}),
  }
}

// J24 (2026-09-23): the desktop main process refuses a switch to or from the
// login service while a turn runs or a gate waits. It reads the workspace
// from its own daemon endpoint and applies the renderer's check to it, so a
// renderer that skipped its own check cannot stop the daemon under that work.
// A workspace that cannot be read throws: not knowing is not a yes.
export async function readLocalServiceHandoffRefusal(input: {
  endpoint: { url: string; token: string }
  timeoutMs: number
}): Promise<string | undefined> {
  const target = localTarget(input.endpoint)
  const deadline = OperationDeadline.start(input.timeoutMs)
  try {
    const snapshot = workspaceSnapshotSchema.parse(await callDaemonOnce({
      target, token: input.endpoint.token, method: "workspace.get", params: {}, deadline,
    }))
    deadline.throwIfExpired()
    return serviceHandoffRefusal(snapshot)
  } finally {
    deadline.clear()
  }
}

export type ServiceHandoffFence = { refusal: string } | { release: () => void }

// Security review round 1 of #576: the read above is a snapshot, and a turn
// can start between it and the stop. This takes the daemon's own fence right
// before the stop. The daemon answers the same refusal, or holds new turns for
// as long as this connection stays open: release() closes it, and so does the
// daemon stopping. Anything else (no daemon, a refused credential, a fence
// already held, a deadline) throws, and the caller must not stop anything.
export async function holdServiceHandoffFence(input: {
  endpoint: { url: string; token: string }
  timeoutMs: number
}): Promise<ServiceHandoffFence> {
  const target = localTarget(input.endpoint)
  const deadline = OperationDeadline.start(input.timeoutMs)
  try {
    const held = await callDaemonHeld({
      target, token: input.endpoint.token, method: "system.serviceHandoffFence", params: {}, deadline,
    })
    let answer
    try {
      answer = rpcMethods["system.serviceHandoffFence"].result.parse(held.result)
      deadline.throwIfExpired()
    } catch (error) {
      held.close()
      throw error
    }
    if (answer.outcome === "refused") {
      held.close()
      return { refusal: answer.refusal }
    }
    return { release: held.close }
  } finally {
    deadline.clear()
  }
}
