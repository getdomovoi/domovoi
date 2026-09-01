import { describe, expect, it } from "vitest"

import {
  sessionTransferParamsSchema,
  transferFromRefParamsSchema,
  transferFromRefResultSchema,
} from "./index.js"

describe("remote ref transfer", () => {
  it("moves by bundle unless another method is named", () => {
    const parsed = sessionTransferParamsSchema.parse({
      sessionId: "session-1",
      targetMachineId: `machine-${"b".repeat(32)}`,
      client: "desktop",
    })

    expect(parsed.method).toBe("git-bundle")
  })

  it("takes a remote when the caller opts into the remote ref path", () => {
    expect(sessionTransferParamsSchema.safeParse({
      sessionId: "session-1",
      targetMachineId: `machine-${"b".repeat(32)}`,
      client: "desktop",
      method: "remote-ref",
      remote: "origin",
    }).success).toBe(true)
  })

  it("refuses the remote ref path with no remote named", () => {
    // The remote is the whole point of the opt-in: it is where the repository
    // lands, and the user has to choose it.
    expect(sessionTransferParamsSchema.safeParse({
      sessionId: "session-1",
      targetMachineId: `machine-${"b".repeat(32)}`,
      client: "desktop",
      method: "remote-ref",
    }).success).toBe(false)
  })

  it("refuses a remote name git would read as an option", () => {
    expect(sessionTransferParamsSchema.safeParse({
      sessionId: "session-1",
      targetMachineId: `machine-${"b".repeat(32)}`,
      client: "desktop",
      method: "remote-ref",
      remote: "--upload-pack=touch",
    }).success).toBe(false)
  })

  it("refuses a remote where the bundle path is asked for", () => {
    expect(sessionTransferParamsSchema.safeParse({
      sessionId: "session-1",
      targetMachineId: `machine-${"b".repeat(32)}`,
      client: "desktop",
      method: "git-bundle",
      remote: "origin",
    }).success).toBe(false)
  })

  it("asks a target to take a session from the remote both machines share", () => {
    expect(transferFromRefParamsSchema.safeParse({
      sessionId: "session-1",
      remote: "origin",
      client: "desktop",
    }).success).toBe(true)
    expect(transferFromRefResultSchema.safeParse({
      workspacePath: "/worktrees/session-1",
      checkpointCommit: "c".repeat(40),
    }).success).toBe(true)
  })
})
