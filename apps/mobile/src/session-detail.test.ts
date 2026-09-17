import {
  demoWorkspace,
  maximumEffectiveClientThreadItems,
  maximumSessionPromptCharacters,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import {
  isPausable,
  promptProblem,
  sendReadiness,
  sessionDetail,
  threadEntries,
} from "./session-detail"

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

describe("threadEntries", () => {
  it("keeps only the session being read", () => {
    const snapshot = workspace()
    const other = snapshot.thread[0]
    if (!other) throw new Error("fixture needs a thread")
    snapshot.thread = [
      ...snapshot.thread,
      { ...other, id: "thread-elsewhere", sessionId: "session-audit" },
    ]

    const { entries } = threadEntries(snapshot, "session-billing")

    expect(entries.some((entry) => entry.id === "thread-elsewhere")).toBe(false)
    expect(entries.length).toBeGreaterThan(0)
  })

  it("says how many items it dropped rather than starting silently mid-thread", () => {
    const snapshot = workspace()
    const item = snapshot.thread.find((candidate) => candidate.kind === "assistant")
    if (!item) throw new Error("fixture needs an assistant item")
    const extra = maximumEffectiveClientThreadItems + 5
    snapshot.thread = Array.from({ length: extra }, (_value, index) => ({
      ...item,
      id: `thread-bulk-${index}`,
    }))

    const { entries, omitted } = threadEntries(snapshot, "session-billing")

    expect(entries).toHaveLength(maximumEffectiveClientThreadItems)
    expect(omitted).toBe(extra - maximumEffectiveClientThreadItems)
  })

  it("gives every thread kind a voice and a body", () => {
    const snapshot = workspace()
    snapshot.thread = [
      {
        id: "t-receipt",
        sessionId: "session-billing",
        kind: "receipt",
        decision: "deny",
        operation: "Apply a production database migration",
        checkpoint: "ckpt_7f21",
        client: "phone",
        createdAt: "2026-08-25T21:52:00.000Z",
      },
      {
        id: "t-tool",
        sessionId: "session-billing",
        kind: "tool",
        tool: "command",
        status: "failed",
        title: "pnpm test",
        createdAt: "2026-08-25T21:52:00.000Z",
      },
    ]

    const { entries } = threadEntries(snapshot, "session-billing")

    expect(entries[0]).toEqual({
      id: "t-receipt",
      voice: "note",
      body: "Denied: Apply a production database migration",
      meta: "decided from phone · ckpt_7f21",
    })
    expect(entries[1]?.meta).toBe("command · failed")
  })
})

describe("threadEntries receipt", () => {
  it("names the outcome, who decided, the credential, the checkpoint and how long it took", () => {
    const snapshot = workspace()
    snapshot.thread = [{
      id: "t-receipt",
      sessionId: "session-billing",
      kind: "receipt",
      decision: "allow-once",
      operation: "pnpm -w prisma migrate deploy",
      checkpoint: "8f3c1de0000000000000000000000000deadbeef",
      client: "phone",
      clientId: "device-fcbd4c3f99c7294586f0c5ca22f9cdf8",
      decisionDurationMs: 38_400,
      createdAt: "2026-08-25T21:52:00.000Z",
    }]

    const { entries } = threadEntries(snapshot, "session-billing")

    expect(entries[0]?.body).toBe("Allowed once: pnpm -w prisma migrate deploy")
    expect(entries[0]?.meta).toBe(
      "decided from phone · credential device-fcbd4c3f99c7294586f0c5ca22f9cdf8 · 8f3c1de · in 38s",
    )
  })

  it("keeps the explanation with the decision and the facts with the record", () => {
    const snapshot = workspace()
    snapshot.thread = [{
      id: "t-receipt",
      sessionId: "session-billing",
      kind: "receipt",
      decision: "deny-explain",
      operation: "rm -rf node_modules",
      checkpoint: "unavailable",
      client: "web",
      explanation: "Not on the release branch.",
      createdAt: "2026-08-25T21:52:00.000Z",
    }]

    const { entries } = threadEntries(snapshot, "session-billing")

    expect(entries[0]?.body).toBe("Denied with an explanation: rm -rf node_modules\nNot on the release branch.")
    expect(entries[0]?.meta).toBe("decided from web · no checkpoint")
  })
})

describe("sessionDetail", () => {
  it("carries the pending approval so the decision stays one tap away", () => {
    const snapshot = workspace()

    expect(sessionDetail(snapshot, "session-billing")?.approvalId).toBe("approval-migrate")
    expect(sessionDetail(snapshot, "session-audit")?.approvalId).toBeUndefined()
  })

  it("returns nothing for a session this snapshot does not have", () => {
    expect(sessionDetail(workspace(), "session-missing")).toBeUndefined()
  })
})

describe("sendReadiness", () => {
  function ready(snapshot: WorkspaceSnapshot) {
    const session = snapshot.sessions[0]
    if (!session) throw new Error("fixture needs a session")
    session.workspacePath = "/Users/dev/.domovoi/worktrees/wt-billing-idem"
    session.providerThreadId = "thread-billing"
    return session
  }

  it("allows a send once the session has a worktree and a provider thread", () => {
    expect(sendReadiness(ready(workspace()), false)).toEqual({ can: true, hint: undefined })
  })

  it("refuses a session the daemon has nothing to send into", () => {
    const snapshot = workspace()
    const session = snapshot.sessions[0]
    if (!session) throw new Error("fixture needs a session")

    const refusal = sendReadiness(session, false)

    expect(refusal.can).toBe(false)
  })

  it("refuses every read-only state with its own reason", () => {
    for (const state of ["archiving", "archived", "transferring", "transferred", "ownership-conflict"] as const) {
      const snapshot = workspace()
      const session = ready(snapshot)
      session.state = state

      expect(sendReadiness(session, false).can).toBe(false)
    }
  })

  it("says a message will steer a running turn rather than refusing it", () => {
    const snapshot = workspace()
    const session = ready(snapshot)
    session.activeTurnId = "turn-1"

    const readiness = sendReadiness(session, false)

    expect(readiness.can).toBe(true)
    expect(readiness.can && readiness.hint).toContain("steers it")
  })

  it("points at the waiting approval first, because that is the faster answer", () => {
    const readiness = sendReadiness(ready(workspace()), true)

    expect(readiness.can && readiness.hint).toContain("approval")
  })
})

describe("promptProblem", () => {
  it("refuses nothing and whitespace, which the daemon trims away too", () => {
    expect(promptProblem("")).toBeDefined()
    expect(promptProblem("   \n ")).toBeDefined()
    expect(promptProblem("ship it")).toBeUndefined()
  })

  it("measures the trimmed prompt against the protocol limit", () => {
    expect(promptProblem(`  ${"a".repeat(maximumSessionPromptCharacters)}  `)).toBeUndefined()
    expect(promptProblem("a".repeat(maximumSessionPromptCharacters + 1))).toBeDefined()
  })
})

describe("isPausable", () => {
  it("needs a provider thread and a turn, because that is what a pause stops", () => {
    const snapshot = workspace()
    const session = snapshot.sessions[0]
    if (!session) throw new Error("fixture needs a session")

    expect(isPausable(session)).toBe(false)

    session.providerThreadId = "thread-billing"
    session.activeTurnId = "turn-1"
    expect(isPausable(session)).toBe(true)
  })

  it("refuses a read-only session, which the daemon would refuse too", () => {
    const snapshot = workspace()
    const session = snapshot.sessions[0]
    if (!session) throw new Error("fixture needs a session")
    session.providerThreadId = "thread-billing"
    session.activeTurnId = "turn-1"
    session.state = "archiving"

    expect(isPausable(session)).toBe(false)
  })
})
