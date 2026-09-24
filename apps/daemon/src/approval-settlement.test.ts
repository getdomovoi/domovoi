import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { unrestrictedApprovalScope } from "./approval-facts.js"
import { ApprovalLedger, savedSettlementInput, settleApproval, type Approval, type SettlementInput } from "./approval-settlement.js"
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

// A card read back from disk names its file only in the saved line. The file
// it names is judged on disk now: a link there can lead into a store since.
describe("settleApproval for a saved file line", () => {
  async function savedFileCard(workspace: string): Promise<Approval> {
    await writeFile(join(workspace, "notes.txt"), "")
    const { approval } = await settleApproval(input(workspace, {
      request: { workspace, cwd: workspace, path: "notes.txt", reason: "Edit a file" },
    }))
    expect(approval).toMatchObject({ risk: "normal", affects: "The file notes.txt in the session worktree." })
    return approval
  }

  async function linkIntoStore(workspace: string, name: string): Promise<void> {
    const store = await worktree()
    await mkdir(join(store, ".aws"))
    await writeFile(join(store, ".aws", "credentials"), "")
    await rm(join(workspace, name), { force: true })
    await symlink(join(store, ".aws", "credentials"), join(workspace, name))
  }

  function settleSaved(approval: Approval, workspace: string, deadline?: OperationDeadline) {
    return settleApproval(savedSettlementInput(approval, workspace, undefined, () => approval.risk), deadline)
  }

  it("hard-gates and hides a saved file that is now a link into a store", async () => {
    const workspace = await worktree()
    const approval = await savedFileCard(workspace)
    await linkIntoStore(workspace, "notes.txt")
    const { approval: settled, sensitive } = await settleSaved(approval, workspace)
    expect(sensitive).toBe(true)
    expect(settled).toMatchObject({ risk: "hard-gate", affects: "The file [REDACTED] in the session worktree." })
  })

  it("judges the link a saved outside file went through", async () => {
    const workspace = await worktree()
    const outside = await worktree()
    const approval = { ...await savedFileCard(workspace), affects: `The file ${join(outside, "plain.txt")}, outside the session worktree, through a link at notes.txt.` }
    await linkIntoStore(workspace, "notes.txt")
    const { approval: settled } = await settleSaved(approval, workspace)
    expect(settled).toMatchObject({ risk: "hard-gate", affects: "The file [REDACTED], outside the session worktree." })
  })

  it("keeps a saved file that still leads to an ordinary file", async () => {
    const workspace = await worktree()
    const approval = await savedFileCard(workspace)
    const { approval: settled, sensitive } = await settleSaved(approval, workspace)
    expect(sensitive).toBe(false)
    expect(settled).toMatchObject({ risk: "normal", affects: "The file notes.txt in the session worktree." })
  })

  it("seals a saved file line it cannot read back as a path", async () => {
    const workspace = await worktree()
    const approval = { ...await savedFileCard(workspace), affects: "The file notes…txt in the session worktree." }
    const { approval: settled, sensitive } = await settleSaved(approval, workspace)
    expect(sensitive).toBe(true)
    expect(settled).toMatchObject({
      risk: "hard-gate",
      affects: "The file [REDACTED] in the session worktree.",
      execution: { state: "unresolved", reason: "sensitive-content" },
    })
  })

  // A card never writes a control character unescaped, so a line that holds
  // one did not come from the card's own sentence and is not read back.
  it("seals a saved file line that does not render back to itself", async () => {
    const workspace = await worktree()
    await writeFile(join(workspace, "notes\u202e.txt"), "")
    const approval = { ...await savedFileCard(workspace), affects: "The file notes\u202e.txt in the session worktree." }
    const { approval: settled, sensitive } = await settleSaved(approval, workspace)
    expect(sensitive).toBe(true)
    expect(settled).toMatchObject({
      risk: "hard-gate",
      affects: "The file [REDACTED] in the session worktree.",
      execution: { state: "unresolved", reason: "sensitive-content" },
    })
  })

  // A file tool's execution depends on the file it names. A saved line that
  // hides that file cannot give the request back, so the card is sealed.
  it("seals a saved file tool card whose file line hides the file", async () => {
    const workspace = await worktree()
    await writeFile(join(workspace, "notes.txt"), "")
    const { approval } = await settleApproval(input(workspace, {
      request: { workspace, cwd: workspace, path: "notes.txt", command: "Edit", reason: "Edit a file" },
    }))
    expect(approval).toMatchObject({ risk: "normal", execution: { state: "resolved" } })
    const hidden = { ...approval, affects: "The file [REDACTED] in the session worktree." }
    const { approval: settled, sensitive } = await settleSaved(hidden, workspace)
    expect(sensitive).toBe(true)
    expect(settled).toMatchObject({
      risk: "hard-gate",
      directory: "[REDACTED] in the session worktree",
      affects: "The file [REDACTED] in the session worktree.",
      execution: { state: "unresolved", reason: "sensitive-content" },
    })
  })

  it("seals a saved file card when the lookup deadline has run out", async () => {
    const workspace = await worktree()
    const approval = await savedFileCard(workspace)
    const deadline = OperationDeadline.start(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const { approval: settled } = await settleSaved(approval, workspace, deadline)
    expect(settled).toMatchObject({
      risk: "hard-gate",
      affects: "The file [REDACTED] in the session worktree.",
      execution: { state: "unresolved", reason: "sensitive-content" },
    })
  })
})

// A card read back from disk is resolved again, and a saved record that
// differs from the fresh one is a hard gate with the record hidden, even when
// no path on the card or in either record is a credential path.
describe("settleApproval for a saved record", () => {
  async function savedScriptCard(workspace: string): Promise<Approval> {
    await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { show: "cat notes.txt" } }))
    await writeFile(join(workspace, "notes.txt"), "")
    const { approval } = await settleApproval(input(workspace, {
      request: { workspace, cwd: workspace, command: "pnpm run show", reason: "Run a command" },
    }))
    expect(approval).toMatchObject({ risk: "normal", directory: workspace, execution: { state: "resolved" } })
    return approval
  }

  function settleSaved(approval: Approval, workspace: string) {
    return settleApproval(savedSettlementInput(approval, workspace, undefined, () => approval.risk))
  }

  it("keeps a saved record that matches the one resolved now", async () => {
    const workspace = await worktree()
    const approval = await savedScriptCard(workspace)
    const { approval: settled, sensitive } = await settleSaved(approval, workspace)
    expect(sensitive).toBe(false)
    expect(settled).toMatchObject({ risk: "normal", execution: approval.execution })
  })

  const mismatches: { name: string; change: (workspace: string, approval: Approval) => Promise<Approval> }[] = [
    {
      name: "a script body that changed on disk",
      change: async (workspace, approval) => {
        await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { show: "cat notes.txt --number" } }))
        return approval
      },
    },
    {
      name: "a saved digest that differs",
      change: async (_, approval) => {
        if (approval.execution.state !== "resolved") throw new Error("Fixture record was not resolved")
        return { ...approval, execution: { ...approval.execution, digest: `sha256:${"0".repeat(64)}` } }
      },
    },
  ]

  for (const mismatch of mismatches) {
    it(`hard-gates and hides a saved record that differs: ${mismatch.name}`, async () => {
      const workspace = await worktree()
      const approval = await mismatch.change(workspace, await savedScriptCard(workspace))
      const { approval: settled, execution, sensitive } = await settleSaved(approval, workspace)
      expect(execution).toMatchObject({ state: "resolved" })
      expect(sensitive).toBe(false)
      expect(settled).toMatchObject({
        risk: "hard-gate",
        directory: workspace,
        execution: { state: "unresolved", reason: "sensitive-content" },
      })
    })
  }
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

  // A changed file line need not keep the card's own format. Sealing keeps a
  // line only when it is a provider's reach, which names no path.
  it("hides a changed file line in any format when it seals", async () => {
    const workspace = await worktree()
    const ledger = new ApprovalLedger()
    const approvals: Approval[] = []
    ledger.admit(approvals, (await settleApproval(input(workspace))).approval)
    approvals.push({ ...approvals[0]!, id: "approval-reach" })
    approvals[0] = { ...approvals[0]!, affects: `Reads ${join(workspace, ".aws", "credentials")} when it runs.` }
    for (const locate of [() => workspace, () => undefined]) {
      const copies = structuredClone(approvals)
      ledger.sealUnsettled(copies, locate)
      expect(copies[0]).toMatchObject({ risk: "hard-gate" })
      expect(copies[0]!.affects).not.toContain(".aws")
      expect(copies[1]).toMatchObject({ risk: "hard-gate", affects: unrestrictedApprovalScope.command })
    }
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
