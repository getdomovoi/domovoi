import { describe, expect, it } from "vitest"

import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { commandTranscriptFor } from "./command-transcript"

describe("commandTranscriptFor", () => {
  it("returns only command tools owned by the active session", () => {
    const snapshot = structuredClone(demoWorkspace) as WorkspaceSnapshot
    snapshot.thread.push(
      {
        id: "command-active",
        sessionId: "session-billing",
        kind: "tool",
        tool: "command",
        status: "completed",
        title: "pnpm test",
        output: "42 passed",
        createdAt: "2026-08-25T22:00:00.000Z",
      },
      {
        id: "file-active",
        sessionId: "session-billing",
        kind: "tool",
        tool: "file-change",
        status: "completed",
        title: "Updated src/app.ts",
        createdAt: "2026-08-25T22:01:00.000Z",
      },
      {
        id: "command-other",
        sessionId: "session-onboarding",
        kind: "tool",
        tool: "command",
        status: "failed",
        title: "pnpm lint",
        createdAt: "2026-08-25T22:02:00.000Z",
      },
    )

    expect(commandTranscriptFor(snapshot)).toEqual([
      expect.objectContaining({ id: "command-active", title: "pnpm test" }),
    ])
  })

  it("returns no transcript without an active session", () => {
    const snapshot = structuredClone(demoWorkspace) as WorkspaceSnapshot
    snapshot.activeSessionId = null

    expect(commandTranscriptFor(snapshot)).toEqual([])
  })
})
