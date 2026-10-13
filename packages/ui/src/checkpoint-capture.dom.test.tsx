import type { MidTurnCheckpoint, SessionHistoryEntry, ThreadItem } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CheckpointsPanel } from "./checkpoints-panel"
import { HistoryPanel } from "./history-panel"
import { CheckpointThreadItem } from "./thread"

afterEach(cleanup)

const checkpoint: Extract<ThreadItem, { kind: "checkpoint" }> = {
  id: "capture", sessionId: "session", kind: "checkpoint", label: "Saved work",
  commit: "a".repeat(40), createdAt: "2026-10-13T00:00:00.000Z",
}

for (const surface of ["thread", "checkpoints", "history"] as const) {
  describe(`${surface} capture facts`, () => {
    function show(midTurn?: MidTurnCheckpoint, reason: "manual" | "before-approved-command" = "manual") {
      const item = { ...checkpoint, reason, ...(midTurn ? { midTurn } : {}) }
      if (surface === "thread") return render(<CheckpointThreadItem item={item} disabled={false} onRestore={vi.fn()} />)
      const entry: Extract<SessionHistoryEntry, { category: "checkpoints" }> = {
        id: "thread:capture", sourceId: item.id, sessionId: item.sessionId, category: "checkpoints",
        label: item.label, commit: item.commit!, createdAt: item.createdAt, reason,
        ...(midTurn ? { midTurn } : {}),
      }
      const props = { sessionId: item.sessionId, connected: true, onLoad: vi.fn(async () => ({ sessionId: item.sessionId, hasMore: false, items: [entry] })) }
      return render(surface === "checkpoints" ? <CheckpointsPanel {...props} /> : <HistoryPanel {...props} />)
    }

    it.each(["manual", "before-approved-command"] as const)("shows one accurate line for %s captures", async (reason) => {
      show({ providerTurnId: "turn-1", stability: "unstable", changedPaths: ["src/a.ts"], changedPathCount: 3 }, reason)
      const origin = reason === "manual" ? "Taken mid-turn while the agent was running." : "Taken before an approved command."
      expect(await screen.findAllByText(`${origin} Files changed while it was taken.`)).toHaveLength(1)
      expect(screen.queryByText(/Two staging passes matched/)).toBeNull()
    })

    it("shows matched approval captures without inventing a turn", async () => {
      show({ stability: "matched", changedPaths: [], changedPathCount: 0 }, "before-approved-command")
      expect(await screen.findAllByText("Taken before an approved command. Two staging passes matched.")).toHaveLength(1)
      expect(screen.queryByText(/mid-turn|Turn ID|Turn:/)).toBeNull()
    })

    it("does not invent changed files for an unstable capture with no observed paths", async () => {
      show({ stability: "unstable", changedPaths: [], changedPathCount: 0 }, "before-approved-command")
      expect(await screen.findAllByText("Taken before an approved command. Capture was unstable.")).toHaveLength(1)
      expect(screen.queryByText(/Files changed while|Changed paths:/)).toBeNull()
    })

    it("makes no capture claim for legacy checkpoints", async () => {
      show()
      expect(await screen.findByText(/Saved work/)).toBeTruthy()
      expect(screen.queryByText(/Taken mid-turn|staging passes|Capture was unstable/)).toBeNull()
    })
  })
}
