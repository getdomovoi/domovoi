import { describe, expect, it } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import { agentPromptWithHandoff, prepareHandoffPrompt } from "./handoff-context.js"

describe("agentPromptWithHandoff", () => {
  it("adds bounded, parseable state to the first post-handoff turn", () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.thread = snapshot.thread.slice(0, 3)
    snapshot.sessions[0]!.workspacePath = "/home/david/.domovoi/worktrees/session-billing"
    snapshot.artifacts.push({
      id: "large-plan",
      sessionId: "session-billing",
      title: "Large plan",
      type: "plan",
      revision: 1,
      mimeType: "text/markdown",
      content: "x".repeat(30_000),
    })

    const prompt = agentPromptWithHandoff(snapshot, "session-billing", "Continue safely")
    const serialized = prompt.match(
      /<domovoi_handoff_context>\n([\s\S]+)\n<\/domovoi_handoff_context>/,
    )?.[1]

    expect(prompt).toContain("<user_request>\nContinue safely\n</user_request>")
    expect(serialized).toBeDefined()
    expect(JSON.parse(serialized!)).toMatchObject({
      handoff: "Handed off codex / gpt-5.3-codex to claude-code / sonnet-4.6.",
      worktree: "/home/david/.domovoi/worktrees/session-billing",
    })
    expect(JSON.parse(serialized!).artifacts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "plan" }),
    ]))
    expect(serialized!.length).toBeLessThanOrEqual(24_000)
  })

  it("does not replay handoff state after the new provider responds", () => {
    expect(agentPromptWithHandoff(
      structuredClone(demoWorkspace),
      "session-billing",
      "Next request",
    )).toBe("Next request")
  })

  it("reports history compacted from the required handoff", () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.thread = [
      ...Array.from({ length: 45 }, (_, index) => ({
        id: `history-${index}`,
        sessionId: "session-billing",
        kind: "assistant" as const,
        body: `History ${index}`,
        createdAt: "2026-09-03T12:00:00.000Z",
      })),
      {
        id: "handoff-history-limit",
        sessionId: "session-billing",
        kind: "system" as const,
        body: "Handed off codex to claude-code.",
        createdAt: "2026-09-03T13:00:00.000Z",
      },
    ]

    expect(prepareHandoffPrompt(snapshot, "session-billing", "Continue").delivery)
      .toEqual({
        status: "delivered",
        omitted: { threadItems: 5, artifacts: 0, annotations: 0 },
      })
  })
})
