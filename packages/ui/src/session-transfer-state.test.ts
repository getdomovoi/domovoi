import type { SessionSummary } from "@getdomovoi/protocol"
import { expect, it } from "vitest"

import {
  forkSessionBlockedReason,
  sessionIsArchiveReadOnly,
  sessionStatusClass,
} from "./workspace-shell.js"

const session: SessionSummary = {
  id: "session-billing",
  projectId: "project-one",
  title: "Billing rewrite",
  state: "idle",
  runtime: { provider: "claude-code", model: "sonnet-4.6", reasoning: "high", permissionMode: "build", auto: false },
  changedFiles: 0,
  testsPassed: 0,
  testsFailed: 0,
  updatedAt: "2026-09-03T12:00:00.000Z",
  workspacePath: "/worktrees/session-billing",
}

it("gives every session state a status colour", () => {
  for (const state of [
    "active", "waiting", "idle", "done", "failed",
    "archiving", "archived", "transferring", "transferred", "ownership-conflict",
  ] as const) {
    expect(sessionStatusClass({ ...session, state })).toBeTruthy()
  }
})

it("treats a session that has moved away as read-only", () => {
  expect(sessionIsArchiveReadOnly({ ...session, state: "transferred" })).toBe(true)
  expect(sessionIsArchiveReadOnly({ ...session, state: "transferring" })).toBe(true)
  expect(sessionIsArchiveReadOnly({ ...session, state: "ownership-conflict" })).toBe(true)
  expect(sessionIsArchiveReadOnly(session)).toBe(false)
})

it("does not call a conflict release a completed move", () => {
  const released = {
    ...session,
    state: "transferred" as const,
    transfer: {
      phase: "transferred" as const,
      transferId: `transfer-${"a".repeat(32)}`,
      targetMachineId: `machine-${"b".repeat(32)}`,
      generation: 3,
      manifestDigest: `sha256:${"c".repeat(64)}`,
      completedAt: "2026-09-04T10:00:00.000Z",
      completion: "conflict-released" as const,
    },
  }

  expect(forkSessionBlockedReason(released, undefined)).toBe(
    "This machine gave up its claim on this session",
  )
  expect(forkSessionBlockedReason(
    { ...released, transfer: { ...released.transfer, completion: "committed" as const } },
    undefined,
  )).toBe("This session moved to another machine")
})

it("refuses to fork a session that has moved or is moving", () => {
  expect(forkSessionBlockedReason({ ...session, state: "transferred" }, undefined))
    .toMatch(/moved|another machine/iu)
  expect(forkSessionBlockedReason({ ...session, state: "transferring" }, undefined))
    .toMatch(/moving|another machine/iu)
  expect(forkSessionBlockedReason({ ...session, state: "ownership-conflict" }, undefined))
    .toMatch(/two machines claim/iu)
})
