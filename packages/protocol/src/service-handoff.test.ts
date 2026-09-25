import { expect, it } from "vitest"

import { demoWorkspace, phoneAndTabletRpcMethods, rpcMethodAuthorizations, rpcMethodMutations, rpcMethods, type WorkspaceSnapshot } from "./index.js"
import { maximumServiceHandoffRefusalLength, serviceHandoffRefusal } from "./service-handoff.js"

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

// Security review round 1 of #576: the check above reads a snapshot, and a
// turn can start between it and the stop. The daemon's own fence answers the
// same question and, when nothing runs or waits, admits no new turn while the
// connection that took it stays open.
it("takes no params and answers fenced or the named refusal, nothing else", () => {
  const method = rpcMethods["system.serviceHandoffFence"]
  expect(method.params.safeParse({}).success).toBe(true)
  expect(method.params.safeParse({ leaseMs: 60_000 }).success).toBe(false)
  expect(method.result.parse({ outcome: "fenced" })).toEqual({ outcome: "fenced" })
  expect(method.result.parse({ outcome: "refused", refusal: "1 turn is running (Fix login)." }))
    .toEqual({ outcome: "refused", refusal: "1 turn is running (Fix login)." })
  for (const answer of [
    {},
    { outcome: "held" },
    { outcome: "refused" },
    { outcome: "refused", refusal: "" },
    { outcome: "refused", refusal: "x".repeat(maximumServiceHandoffRefusalLength + 1) },
    { outcome: "fenced", refusal: "1 turn is running (Fix login)." },
  ]) {
    expect(method.result.safeParse(answer).success).toBe(false)
  }
})

it("is a control method outside the phone and tablet set, and holds only live state", () => {
  expect(rpcMethodAuthorizations["system.serviceHandoffFence"]).toBe("control")
  expect(rpcMethodMutations["system.serviceHandoffFence"]).toBe("read-only")
  expect(phoneAndTabletRpcMethods.has("system.serviceHandoffFence")).toBe(false)
})
