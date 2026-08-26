import { describe, expect, it } from "vitest"

import {
  annotationSchema,
  annotationCreateParamsSchema,
  annotationReplyParamsSchema,
  annotationSetStatusParamsSchema,
  approvalResolveParamsSchema,
  checkpointCreateParamsSchema,
  createEmptyWorkspace,
  demoWorkspace,
  projectOpenParamsSchema,
  sessionActivateParamsSchema,
  sessionCreateParamsSchema,
  sessionSendParamsSchema,
  workspaceSnapshotSchema,
} from "./index.js"

describe("workspace protocol", () => {
  it("validates anchored annotation threads", () => {
    const annotation = {
      id: "annotation-1",
      sessionId: "session-billing",
      artifactId: "artifact-preview",
      anchor: {
        cssSelector: "main > section:nth-child(2)",
        textQuote: "Apply the migration",
        bbox: { x: 40, y: 120, width: 280, height: 48 },
      },
      body: "Run this step on staging first.",
      status: "open",
      origin: "tablet",
      thread: [{
        id: "annotation-reply-1",
        body: "Agreed. I will revise the plan.",
        origin: "desktop",
        createdAt: "2026-08-25T22:00:00.000Z",
      }],
      createdAt: "2026-08-25T21:55:00.000Z",
      updatedAt: "2026-08-25T22:00:00.000Z",
    }

    expect(annotationSchema.parse(annotation)).toEqual(annotation)
    expect(annotationSchema.safeParse({
      ...annotation,
      anchor: {},
    }).success).toBe(false)
  })

  it("validates annotation mutation requests", () => {
    expect(annotationCreateParamsSchema.parse({
      sessionId: "session-billing",
      artifactId: "artifact-preview",
      variantId: "variant-b",
      anchor: { textQuote: "Replay operations" },
      body: "Keep the progress visible.",
      client: "tablet",
    }).client).toBe("tablet")
    expect(annotationReplyParamsSchema.parse({
      annotationId: "annotation-1",
      body: "Updated in revision four.",
      client: "desktop",
    }).body).toBe("Updated in revision four.")
    expect(annotationSetStatusParamsSchema.parse({
      annotationId: "annotation-1",
      status: "resolved",
      client: "phone",
    }).status).toBe("resolved")
  })

  it("upgrades snapshots that predate annotation state", () => {
    const legacy = structuredClone(demoWorkspace) as unknown as Record<string, unknown>
    delete legacy.annotations

    expect(workspaceSnapshotSchema.parse(legacy).annotations).toEqual([])
  })

  it("rejects annotations detached from their session artifact", () => {
    const detached = structuredClone(demoWorkspace)
    detached.annotations[0]!.artifactId = "artifact-missing"
    expect(workspaceSnapshotSchema.safeParse(detached).success).toBe(false)

    const crossed = structuredClone(demoWorkspace)
    crossed.artifacts.push({
      id: "artifact-onboarding",
      sessionId: "session-onboarding",
      title: "Onboarding preview",
      type: "preview",
      revision: 1,
    })
    crossed.annotations[0]!.artifactId = "artifact-onboarding"
    expect(workspaceSnapshotSchema.safeParse(crossed).success).toBe(false)
  })

  it("represents a machine before a project is opened", () => {
    const empty = createEmptyWorkspace(demoWorkspace.machine)

    expect(workspaceSnapshotSchema.parse(empty)).toMatchObject({
      project: null,
      sessions: [],
      activeSessionId: null,
    })

    const inconsistent = structuredClone(empty)
    inconsistent.sessions = structuredClone(demoWorkspace.sessions)
    expect(workspaceSnapshotSchema.safeParse(inconsistent).success).toBe(false)
  })

  it("accepts the shared demo snapshot", () => {
    expect(workspaceSnapshotSchema.parse(demoWorkspace)).toEqual(demoWorkspace)
  })

  it("rejects a Build auto state represented as a fake permission mode", () => {
    const broken = structuredClone(demoWorkspace)
    broken.sessions[0]!.runtime.permissionMode = "build-auto" as "build"

    expect(workspaceSnapshotSchema.safeParse(broken).success).toBe(false)
  })

  it("requires non-empty active and thread session identifiers", () => {
    const emptyActive = structuredClone(demoWorkspace)
    emptyActive.activeSessionId = ""
    expect(workspaceSnapshotSchema.safeParse(emptyActive).success).toBe(false)

    const unscopedThread = structuredClone(demoWorkspace) as unknown as {
      thread: Array<Record<string, unknown>>
    }
    delete unscopedThread.thread[0]!.sessionId
    expect(workspaceSnapshotSchema.safeParse(unscopedThread).success).toBe(false)
  })

  it("requires an explanation for deny-explain decisions", () => {
    expect(
      approvalResolveParamsSchema.safeParse({
        approvalId: "approval-migrate",
        decision: "deny-explain",
        client: "desktop",
      }).success,
    ).toBe(false)

    expect(
      approvalResolveParamsSchema.parse({
        approvalId: "approval-migrate",
        decision: "deny-explain",
        client: "desktop",
        explanation: "Use a staging database first.",
      }).explanation,
    ).toBe("Use a staging database first.")
  })

  it("validates the local project and session lifecycle", () => {
    expect(projectOpenParamsSchema.parse({ path: "/code/domovoi", client: "desktop" })).toEqual({
      path: "/code/domovoi",
      client: "desktop",
    })
    expect(sessionCreateParamsSchema.parse({
      title: "Add persistence",
      runtime: demoWorkspace.sessions[0]!.runtime,
      client: "desktop",
    }).title).toBe("Add persistence")
    expect(sessionActivateParamsSchema.parse({
      sessionId: "session-1",
      client: "desktop",
    }).sessionId).toBe("session-1")
    expect(sessionSendParamsSchema.parse({
      sessionId: "session-1",
      prompt: "Run the tests",
      client: "desktop",
    }).prompt).toBe("Run the tests")
    expect(checkpointCreateParamsSchema.parse({
      sessionId: "session-1",
      label: "before-turn",
      client: "desktop",
    }).label).toBe("before-turn")
  })
})
