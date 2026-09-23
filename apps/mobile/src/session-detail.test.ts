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
  sendReadinessOverSocket,
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
        id: "t-refusal",
        sessionId: "session-billing",
        kind: "policy-refusal",
        operation: "Apply a production database migration",
        command: "prisma migrate deploy --url $PROD_DATABASE_URL",
        rule: "no writes to a production database",
        setBy: "dana@acme.dev",
        scope: "every machine on this account",
        remedy: "Run it against acme_dev instead.",
        createdAt: "2026-08-25T21:51:00.000Z",
      },
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

    expect(entries[0]).toMatchObject({
      id: "t-refusal",
      kind: "policy-refusal",
      rule: "no writes to a production database",
    })
    expect(entries[1]).toMatchObject({
      id: "t-receipt",
      kind: "receipt",
      operation: "Apply a production database migration",
      checkpoint: "ckpt_7f21",
    })
    const note = entries[2]
    expect(note?.kind).toBe("note")
    expect(note?.kind === "note" ? note.meta : undefined).toBe("command · failed")
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

    expect(entries[0]).toEqual({
      id: "t-receipt",
      kind: "receipt",
      decision: "Allowed once",
      operation: "pnpm -w prisma migrate deploy",
      explanation: undefined,
      attribution: "phone · device fcbd…cdf8",
      checkpoint: "8f3c1de",
      duration: "38s",
    })
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

    expect(entries[0]).toMatchObject({
      kind: "receipt",
      decision: "Denied with an explanation",
      operation: "rm -rf node_modules",
      explanation: "Not on the release branch.",
      attribution: "web",
      checkpoint: "no checkpoint",
      duration: undefined,
    })
  })
})

describe("sessionDetail", () => {
  it("carries the pending approval so the decision stays one tap away", () => {
    const snapshot = workspace()

    expect(sessionDetail(snapshot, "session-billing")?.approvalId).toBe("approval-migrate")
    expect(sessionDetail(snapshot, "session-audit")?.approvalId).toBeUndefined()
  })

  it("carries the daemon-owned queued send and latest policy refusal", () => {
    const snapshot = workspace()
    snapshot.queuedSends = [{
      id: "queue-1",
      sessionId: "session-billing",
      state: "held",
      createdAt: "2026-08-25T21:52:00.000Z",
      origin: { client: "phone", clientId: "device-1", connectionId: "connection-1" },
      skillIds: [],
      attachments: [],
      reason: "Waiting for the current turn boundary.",
    }]
    snapshot.thread.push({
      id: "refusal-1",
      sessionId: "session-billing",
      kind: "policy-refusal",
      operation: "Apply a production database migration",
      command: "prisma migrate deploy --url $PROD_DATABASE_URL",
      rule: "no writes to a production database",
      setBy: "dana@acme.dev",
      scope: "every machine on this account",
      remedy: "Run it against acme_dev instead.",
      createdAt: "2026-08-25T21:53:00.000Z",
    })

    expect(sessionDetail(snapshot, "session-billing")).toMatchObject({
      queuedSend: { id: "queue-1", state: "held" },
      policyRefusal: { id: "refusal-1", kind: "policy-refusal" },
    })
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

  // The route can die with the composer open. The session is still on the
  // machine, so the reason says so instead of offering a Send that would fail
  // after the person has typed.
  it("refuses a send while the socket is not open, and says the session is still there", () => {
    const open = sendReadiness(ready(workspace()), false)
    expect(sendReadinessOverSocket("open", open)).toBe(open)
    expect(sendReadinessOverSocket("closed", open)).toEqual({
      can: false,
      reason: "Not connected. The session is still on the machine; this reply cannot reach it yet.",
    })
    expect(sendReadinessOverSocket("connecting", open)).toEqual({
      can: false,
      reason: "Connecting. The session is still on the machine; this reply cannot reach it yet.",
    })
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

  it("describes next-turn replacement without steer copy during an active turn", () => {
    const snapshot = workspace()
    const session = ready(snapshot)
    session.activeTurnId = "turn-1"

    const readiness = sendReadiness(session, false)

    expect(readiness).toEqual({
      can: true,
      hint: "A turn is running, so this will queue and send at the boundary.",
    })
    expect(readiness.can && readiness.hint).not.toContain("steer")
  })

  it("locks the composer for authoritative watching-only access", () => {
    expect(sendReadiness(ready(workspace()), false, "watching")).toEqual({
      can: false,
      reason: "Watching only. This phone can read the session but cannot change it.",
    })
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

describe("context compaction", () => {
  it("says what survived a compaction", () => {
    const snapshot = workspace()
    snapshot.thread = [{
      id: "system-compaction",
      sessionId: snapshot.activeSessionId!,
      kind: "system",
      body: "Context compacted.",
      notice: "context-compaction",
      createdAt: "2026-09-08T09:00:01.000Z",
    }]
    const { entries } = threadEntries(snapshot, snapshot.activeSessionId!)
    expect(entries[0]).toMatchObject({
      kind: "note",
      body: "Context compacted.",
      meta: "Domovoi kept the thread above.",
    })
  })

  it("leaves another system row's detail alone", () => {
    const snapshot = workspace()
    snapshot.thread = [{
      id: "system-handoff",
      sessionId: snapshot.activeSessionId!,
      kind: "system",
      body: "Handed off to another provider.",
      detail: "Hidden reasoning did not transfer.",
      createdAt: "2026-09-08T09:00:01.000Z",
    }]
    const { entries } = threadEntries(snapshot, snapshot.activeSessionId!)
    expect(entries[0]).toMatchObject({ meta: "Hidden reasoning did not transfer." })
  })
})
