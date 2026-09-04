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
    "archiving", "archived", "transferring", "transferred",
  ] as const) {
    expect(sessionStatusClass({ ...session, state })).toBeTruthy()
  }
})

it("treats a session that has moved away as read-only", () => {
  expect(sessionIsArchiveReadOnly({ ...session, state: "transferred" })).toBe(true)
  expect(sessionIsArchiveReadOnly({ ...session, state: "transferring" })).toBe(true)
  expect(sessionIsArchiveReadOnly(session)).toBe(false)
})

it("refuses to fork a session that has moved or is moving", () => {
  expect(forkSessionBlockedReason({ ...session, state: "transferred" }, undefined))
    .toMatch(/moved|another machine/iu)
  expect(forkSessionBlockedReason({ ...session, state: "transferring" }, undefined))
    .toMatch(/moving|another machine/iu)
})
