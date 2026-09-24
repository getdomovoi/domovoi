import { mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { ApprovalLedger, settleApproval, type Approval, type SettlementInput } from "./approval-settlement.js"
import { OperationDeadline } from "./operation-deadline.js"
import { removeScratchDirectories } from "./test-scratch.js"

const scratch: string[] = []
afterEach(async () => {
  await removeScratchDirectories(scratch)
})

async function worktree(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "domovoi-ledger-")))
  scratch.push(directory)
  return directory
}

function input(workspace: string, overrides: Partial<SettlementInput> = {}): SettlementInput {
  return {
    approval: {
      id: "approval-ledger",
      sessionId: "session-ledger",
      machine: "machine",
      agent: "claude-code / sonnet",
      mode: "build",
      estimatedDuration: "Unknown",
      checkpoint: "unavailable",
      requestedAt: "2026-09-24T00:00:00.000Z",
    },
    request: { workspace, cwd: workspace, command: "ls", reason: "List files" },
    scope: undefined,
    execution: "resolve",
    risk: () => "normal",
    ...overrides,
  }
}

describe("settleApproval", () => {
  it("settles an ordinary request at the policy's risk", async () => {
    const workspace = await worktree()
    const { approval, sensitive } = await settleApproval(input(workspace))
    expect(sensitive).toBe(false)
    expect(approval).toMatchObject({ risk: "normal", directory: workspace, command: "ls", execution: { state: "resolved" } })
  })

  it("seals the card when the request's deadline has run out", async () => {
    const workspace = await worktree()
    const deadline = OperationDeadline.start(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const { approval, sensitive } = await settleApproval(input(workspace, {
      request: { workspace, cwd: workspace, path: "notes.txt", command: "cat notes.txt", reason: "Read a file" },
    }), deadline)
    expect(sensitive).toBe(true)
    expect(approval).toMatchObject({
      risk: "hard-gate",
      command: "cat notes.txt",
      operation: "Read a file",
      directory: "[REDACTED] in the session worktree",
      affects: "The file [REDACTED] in the session worktree.",
      execution: { state: "unresolved", reason: "sensitive-content" },
    })
  })
})

describe("ApprovalLedger", () => {
  it("admits only an approval settleApproval made", async () => {
    const workspace = await worktree()
    const ledger = new ApprovalLedger()
    const approvals: Approval[] = []
    const { approval } = await settleApproval(input(workspace))
    expect(() => ledger.admit(approvals, structuredClone(approval) as typeof approval)).toThrow(TypeError)
    ledger.admit(approvals, approval)
    expect(approvals).toEqual([approval])
    expect(ledger.isSettled(structuredClone(approval))).toBe(true)
  })

  it("seals an approval changed after it was admitted, and one it never admitted", async () => {
    const workspace = await worktree()
    const ledger = new ApprovalLedger()
    const approvals: Approval[] = []
    ledger.admit(approvals, (await settleApproval(input(workspace))).approval)
    approvals[0] = { ...approvals[0]!, directory: join(workspace, ".ssh") }
    approvals.push({ ...approvals[0]!, id: "approval-unknown", directory: workspace })
    expect(ledger.sealUnsettled(approvals, () => workspace)).toEqual(["approval-ledger", "approval-unknown"])
    for (const approval of approvals) {
      expect(approval).toMatchObject({
        risk: "hard-gate",
        directory: "[REDACTED] in the session worktree",
        execution: { state: "unresolved", reason: "sensitive-content" },
      })
      expect(ledger.isSettled(approval)).toBe(true)
    }
    expect(ledger.sealUnsettled(approvals, () => workspace)).toEqual([])
  })

  it("puts back a settled copy as it was, and a changed copy sealed", async () => {
    const workspace = await worktree()
    const ledger = new ApprovalLedger()
    const held: Approval[] = []
    const { approval } = await settleApproval(input(workspace))
    ledger.admit(held, approval)
    const restored: Approval[] = []
    ledger.restore(restored, structuredClone(approval), () => workspace)
    expect(restored).toEqual([approval])
    const changed: Approval[] = []
    ledger.restore(changed, { ...approval, risk: "normal", command: "cat ~/.aws/credentials" }, () => workspace)
    expect(changed[0]).toMatchObject({ risk: "hard-gate", directory: "[REDACTED] in the session worktree" })
  })
})
