import {
  runtimeDiscoverResultSchema,
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { clientKind } from "./lib/protocol-facts"

export const noOpenProjectReason = "Open a project on the machine before starting a session."

export type FreshSessionReadiness =
  | { canStart: true, reason: undefined }
  | { canStart: false, reason: string }

type RpcCall = (method: string, params: unknown) => Promise<unknown>

export function freshSessionReadiness(snapshot: WorkspaceSnapshot): FreshSessionReadiness {
  if (!snapshot.project) return { canStart: false, reason: noOpenProjectReason }
  const provider = snapshot.machine.providers.find((candidate) => candidate.sessionCapable && candidate.status === "ready")
  if (!provider) return { canStart: false, reason: "No ready session provider is available on this machine." }
  return { canStart: true, reason: undefined }
}

export async function startFreshSession(
  snapshot: WorkspaceSnapshot,
  prompt: string,
  call: RpcCall,
): Promise<string> {
  const readiness = freshSessionReadiness(snapshot)
  if (!readiness.canStart) throw new Error(readiness.reason)
  const provider = snapshot.machine.providers.find((candidate) => candidate.sessionCapable && candidate.status === "ready")
  if (!provider) throw new Error("No ready session provider is available on this machine.")
  const discovery = runtimeDiscoverResultSchema.parse(await call("runtime.discover", {
    provider: provider.id,
    client: clientKind,
  }))
  if (discovery.status === "unavailable") throw new Error(discovery.message)
  const trimmed = prompt.trim()
  const firstLine = trimmed.split("\n")[0]?.trim() ?? trimmed
  const created = workspaceSnapshotSchema.parse(await call("session.create", {
    title: firstLine.slice(0, 120),
    runtime: discovery.defaultRuntime,
    client: clientKind,
  }))
  const sessionId = created.activeSessionId
  if (!sessionId) throw new Error("The daemon created the session but did not say which")
  await call("session.send", { sessionId, prompt: trimmed, client: clientKind })
  return sessionId
}
