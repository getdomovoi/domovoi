import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { approvalFacts, unrestrictedApprovalScope } from "./approval-facts.js"
import { codexApprovalScope } from "./codex.js"

const workspace = join("/", "worktrees", "session-1")

describe("approvalFacts", () => {
  it("says a command from an unsandboxed provider can reach the machine and its network", () => {
    expect(approvalFacts({ workspace, scope: undefined })).toEqual({
      affects: unrestrictedApprovalScope.command,
      network: unrestrictedApprovalScope.network,
    })
    expect(unrestrictedApprovalScope.network).not.toMatch(/no .*network/i)
  })

  it("names the file a file request is about, and says when it is outside the worktree", () => {
    expect(approvalFacts({ workspace, path: join(workspace, "src", "index.ts"), scope: undefined }).affects)
      .toBe("The file src/index.ts in the session worktree.")
    expect(approvalFacts({ workspace, path: join("/", "etc", "hosts"), scope: undefined }).affects)
      .toBe(`The file ${resolve(join("/", "etc", "hosts"))}, outside the session worktree.`)
  })

  it("describes the Codex sandbox and what running outside it means", () => {
    const facts = approvalFacts({ workspace, scope: codexApprovalScope })
    expect(facts.affects).toMatch(/sandbox/)
    expect(facts.network).toMatch(/outside the sandbox/)
  })
})
