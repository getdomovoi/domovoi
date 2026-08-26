import { describe, expect, it } from "vitest"

import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { commandsForActiveSession } from "./commands"

describe("commandsForActiveSession", () => {
  it("returns only command tools owned by the active session", () => {
    const snapshot = structuredClone(demoWorkspace) as WorkspaceSnapshot
    snapshot.thread.push(
      {
        id: "tool-test",
        sessionId: "session-billing",
        kind: "tool",
        tool: "command",
        status: "completed",
        title: "pnpm test",
        output: "25 passed",
        createdAt: "2026-08-25T22:00:00.000Z",
      },
      {
        id: "tool-files",
        sessionId: "session-billing",
        kind: "tool",
        tool: "file-change",
        status: "completed",
        title: "Changed files",
        createdAt: "2026-08-25T22:01:00.000Z",
      },
      {
        id: "tool-other",
        sessionId: "session-onboarding",
        kind: "tool",
        tool: "command",
        status: "failed",
        title: "pnpm build",
        createdAt: "2026-08-25T22:02:00.000Z",
      },
    )

    expect(commandsForActiveSession(snapshot).map((command) => command.id)).toEqual(["tool-test"])
  })

  it("returns no commands without an active session", () => {
    const snapshot = structuredClone(demoWorkspace) as WorkspaceSnapshot
    snapshot.activeSessionId = null

    expect(commandsForActiveSession(snapshot)).toEqual([])
  })
})
