import { expect, it } from "vitest"

import { demoWorkspace, type WorkspaceSnapshot } from "./index.js"
import { serviceHandoffRefusal } from "./service-handoff.js"

function snapshot(): WorkspaceSnapshot {
  const next = structuredClone(demoWorkspace)
  for (const session of next.sessions) { delete (session as { activeTurnId?: string }).activeTurnId; session.state = "idle" }
  next.approvals = []
  return next
}

it("allows the handoff when nothing runs and nothing waits", () => {
  expect(serviceHandoffRefusal(snapshot())).toBeUndefined()
})

it("names the running turns and the waiting gates", () => {
  const next = snapshot()
  const [first, second] = next.sessions
  first!.state = "active"; first!.activeTurnId = "turn-1"
  next.approvals = [{ ...demoWorkspace.approvals[0]!, sessionId: second!.id }]
  expect(serviceHandoffRefusal(next)).toBe(`1 turn is running (${first!.title}) and 1 gate is waiting (${second!.title}).`)
})
