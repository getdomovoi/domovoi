import { z } from "zod"

import type { WorkspaceSnapshot } from "./schema.js"
import { utf16MaxLength } from "./validation.js"

// J24, ruled 2026-09-23: the switch to the login service refuses while a turn
// runs or a gate waits, and the refusal names which. Read from the snapshot
// the client already holds; nothing is asked of the daemon and nothing is
// interrupted. The desktop main process applies the same check to a snapshot
// it reads itself before it stops anything, so the renderer is not the only
// gate.
export function serviceHandoffRefusal(snapshot: Pick<WorkspaceSnapshot, "sessions" | "approvals">): string | undefined {
  const title = (sessionId: string) => snapshot.sessions.find((session) => session.id === sessionId)?.title ?? sessionId
  const running = snapshot.sessions.filter((session) => session.state === "active" && session.activeTurnId).map((session) => session.title)
  const waiting = [...new Set(snapshot.approvals.map((approval) => approval.sessionId))].map(title)
  if (running.length === 0 && waiting.length === 0) return undefined
  const parts: string[] = []
  if (running.length) parts.push(`${running.length} ${running.length === 1 ? "turn is" : "turns are"} running (${running.join(", ")})`)
  if (waiting.length) parts.push(`${waiting.length} ${waiting.length === 1 ? "gate is" : "gates are"} waiting (${waiting.join(", ")})`)
  return `${parts.join(" and ")}.`
}

// Security review round 1 of #576: the check above reads a snapshot, and a
// turn can start between that read and the stop. `system.serviceHandoffFence`
// asks the daemon the same question inside the daemon. When nothing runs, no
// dispatch is in flight and no gate waits, the daemon admits no new turn while
// the connection that took the fence stays open; closing that connection (or
// the daemon stopping) lifts it. Otherwise it answers the refusal, named as
// above. Only a loopback connection on the daemon's own credential may take it.
export const maximumServiceHandoffRefusalLength = 65_536

export const serviceHandoffFenceParamsSchema = z.object({}).strict()

export const serviceHandoffFenceResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("fenced") }).strict(),
  z.object({
    outcome: z.literal("refused"),
    refusal: z.string().min(1).check(utf16MaxLength(maximumServiceHandoffRefusalLength)),
  }).strict(),
])

export type ServiceHandoffFenceResult = z.infer<typeof serviceHandoffFenceResultSchema>
