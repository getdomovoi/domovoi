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

  // Codex review of PR #717: the daemon records how many open comments a sent
  // message left over the per-turn limit. The phone says so under that
  // message, in the sentence desktop and web use, for as long as it shows it.
  it("says how many open comments a sent message left over the per-turn limit", () => {
    const delivery = (limit: number) => ({
      version: 1 as const,
      budget: { unit: "utf16-code-units" as const, limit: 262_144, used: 9_000 },
      handoff: { status: "not-required" as const },
      workingPlan: { status: "not-required" as const },
      annotations: { availableCount: limit, deliveredIds: [], omitted: { budget: 0, limit } },
      skills: { selection: "project-default" as const, delivered: [], omitted: { budget: [], limit: [], unavailable: [], reviewChanged: [], policy: [] } },
    })
    const user = (id: string, providerPromptDelivery?: ReturnType<typeof delivery>) => ({
      id, sessionId: "session-billing", kind: "user" as const, body: "Address these", createdAt: "2026-09-30T14:00:00.000Z",
      ...(providerPromptDelivery ? { providerPromptDelivery } : {}),
    })
    const snapshot = workspace()
    snapshot.thread = [user("one", delivery(1)), user("three", delivery(3)), user("none", delivery(0)), user("untracked")]

    const { entries } = threadEntries(snapshot, "session-billing")

    expect(entries).toEqual([
      { id: "one", kind: "message", voice: "you", body: "Address these", omission: "1 open annotation was over the per-turn limit" },
      { id: "three", kind: "message", voice: "you", body: "Address these", omission: "3 open annotations were over the per-turn limit" },
      { id: "none", kind: "message", voice: "you", body: "Address these" },
      { id: "untracked", kind: "message", voice: "you", body: "Address these" },
    ])
  })
})

// Ruling Q357 A: only the latest receipt in the open turn is drawn in full.
// Receipts carry no turn id today, so a receipt belongs to the open turn when
// the session holds one and no message of yours has started another since.
describe("current receipt", () => {
  function receipt(id: string, createdAt: string) {
    return {
      id, sessionId: "session-billing", kind: "receipt" as const, decision: "allow-once" as const,
      operation: "pnpm test", checkpoint: "8f3c1de0000000000000000000000000deadbeef", client: "phone" as const, createdAt,
    }
  }
  function you(id: string, createdAt: string) {
    return { id, sessionId: "session-billing", kind: "user" as const, body: "next", createdAt }
  }
  function currents(running: boolean, thread: WorkspaceSnapshot["thread"]): boolean[] {
    const snapshot = workspace()
    const session = snapshot.sessions.find((candidate) => candidate.id === "session-billing")!
    session.activeTurnId = running ? "turn-open" : undefined
    snapshot.thread = thread
    const detail = sessionDetail(snapshot, "session-billing")!
    return detail.entries.flatMap((entry) => entry.kind === "receipt" ? [entry.current] : [])
  }

  it("marks the latest receipt of a running turn as current, and no other", () => {
    expect(currents(true, [receipt("r1", "2026-08-25T21:40:00.000Z"), receipt("r2", "2026-08-25T21:50:00.000Z")])).toEqual([false, true])
  })

  it("marks nothing current once your next message has started another turn", () => {
    expect(currents(true, [receipt("r1", "2026-08-25T21:40:00.000Z"), you("u1", "2026-08-25T21:50:00.000Z")])).toEqual([false])
  })

  // A thread item's turnId is the daemon's usage digest (64 hex), never the
  // raw provider id in session.activeTurnId, so a receipt's turnId cannot say
  // whether it belongs to the open turn and must not make it history.
  it("keeps a receipt current when it carries the daemon's digest turn id", () => {
    const digest = "a3f1".repeat(16)
    expect(currents(true, [{ ...receipt("r1", "2026-08-25T21:40:00.000Z"), turnId: digest }])).toEqual([true])
  })

  it("marks nothing current while no turn is running", () => {
    expect(currents(false, [receipt("r1", "2026-08-25T21:40:00.000Z")])).toEqual([false])
  })
})

describe("threadEntries receipt", () => {
  // decisionDurationMs is how long the gate waited for an answer; ranForMs is
  // how long the allowed command took once answered. The design's "ran in" is
  // the second, so the two are carried apart.
  // A legacy receipt carries the client id a hello declared, which no paired
  // credential vouches for, so it is named as declared (as packages/ui does).
  it("names the outcome, who decided, the declared client, the checkpoint and how long it ran", () => {
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
      ranForMs: 12_300,
      createdAt: "2026-08-25T21:52:00.000Z",
    }]

    const { entries } = threadEntries(snapshot, "session-billing")

    expect(entries[0]).toEqual({
      id: "t-receipt",
      kind: "receipt",
      decision: "Allowed once",
      recorded: "allow-once",
      operation: "pnpm -w prisma migrate deploy",
      explanation: undefined,
      client: "phone",
      declaredClient: "device fcbd…cdf8",
      checkpoint: "8f3c1de",
      checkpointTaken: true,
      ranFor: "12s",
      decidedAfter: "38s",
      // The fixture's session holds no open turn.
      current: false,
    })
  })

  // A current receipt records the id of the connection the decision came
  // over and declares no client id, so it names no declared client.
  it("names no declared client on a receipt that records a connection", () => {
    const snapshot = workspace()
    snapshot.thread = [{
      id: "t-receipt",
      sessionId: "session-billing",
      kind: "receipt",
      decision: "allow-once",
      operation: "pnpm test",
      checkpoint: "8f3c1de0000000000000000000000000deadbeef",
      client: "phone",
      connectionId: "3f1c2b8e-1d2a-4c5b-9e6f-7a8b9c0d1e2f",
      createdAt: "2026-08-25T21:52:00.000Z",
    }]

    expect(threadEntries(snapshot, "session-billing").entries[0]).toMatchObject({ declaredClient: undefined })
  })

  it("says minutes for a command that ran past one", () => {
    const snapshot = workspace()
    snapshot.thread = [{
      id: "t-receipt",
      sessionId: "session-billing",
      kind: "receipt",
      decision: "always-project",
      operation: "pnpm test",
      checkpoint: "8f3c1de0000000000000000000000000deadbeef",
      client: "phone",
      ranForMs: 252_000,
      createdAt: "2026-08-25T21:52:00.000Z",
    }]

    expect(threadEntries(snapshot, "session-billing").entries[0]).toMatchObject({
      checkpointTaken: true,
      ranFor: "4m 12s",
    })
  })

  // Past an hour, seconds stop helping and minutes count up from the hour,
  // so 65 minutes reads 1h 5m rather than 65m 0s.
  it("says hours for a command that ran past one", () => {
    const snapshot = workspace()
    snapshot.thread = [{
      id: "t-receipt",
      sessionId: "session-billing",
      kind: "receipt",
      decision: "allow-once",
      operation: "pnpm test",
      checkpoint: "8f3c1de0000000000000000000000000deadbeef",
      client: "phone",
      ranForMs: 65 * 60_000 + 20_000,
      createdAt: "2026-08-25T21:52:00.000Z",
    }]

    expect(threadEntries(snapshot, "session-billing").entries[0]).toMatchObject({ ranFor: "1h 5m" })
  })

  // Only an allow takes a checkpoint before the command, and only when the
  // daemon could take one. A deny records the session's reference instead.
  it("does not claim a checkpoint was taken for a deny or when none could be", () => {
    const snapshot = workspace()
    snapshot.thread = [
      {
        id: "t-deny",
        sessionId: "session-billing",
        kind: "receipt",
        decision: "deny",
        operation: "pnpm test",
        checkpoint: "8f3c1de0000000000000000000000000deadbeef",
        client: "phone",
        createdAt: "2026-08-25T21:52:00.000Z",
      },
      {
        id: "t-none",
        sessionId: "session-billing",
        kind: "receipt",
        decision: "allow-once",
        operation: "pnpm test",
        checkpoint: "unavailable",
        client: "phone",
        createdAt: "2026-08-25T21:53:00.000Z",
      },
    ]

    const { entries } = threadEntries(snapshot, "session-billing")

    expect(entries.map((entry) => entry.kind === "receipt" && entry.checkpointTaken)).toEqual([false, false])
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
      client: "web",
      declaredClient: undefined,
      checkpoint: "no checkpoint",
      checkpointTaken: false,
      ranFor: undefined,
      decidedAfter: undefined,
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
