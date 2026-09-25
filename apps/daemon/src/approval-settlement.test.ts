import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { unrestrictedApprovalScope } from "./approval-facts.js"
import {
  ApprovalLedger,
  sameExecution,
  savedSettlementInput,
  settleApproval,
  type Approval,
  type SettlementInput,
} from "./approval-settlement.js"
import { fileScopedTools, resolveExecution } from "./execution-resolution.js"
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
    // The sealed card hides its file, so that path is hidden in the command
    // line too; the rest of the agent's text stays.
    expect(approval).toMatchObject({
      risk: "hard-gate",
      command: "cat [REDACTED]",
      operation: "Read a file",
      directory: "[REDACTED] in the session worktree",
      affects: "The file [REDACTED] in the session worktree.",
      execution: { state: "unresolved", reason: "sensitive-content" },
    })
  })
})

// Owner ruling, late 2026-09-24: when a card hides a path, only that exact
// path is replaced in its operation and command lines, as written, at its
// real path, and in the forms the path classifier compares. The rest of the
// agent's text stays.
describe("settleApproval hides the paths it hides in the card's own text", () => {
  function settle(workspace: string, request: Partial<SettlementInput["request"]>, deadline?: OperationDeadline) {
    return settleApproval(input(workspace, { request: { workspace, cwd: workspace, ...request } }), deadline)
  }

  it("replaces a credential path in the command and the operation, and keeps the rest", async () => {
    const workspace = await worktree()
    const { approval } = await settle(workspace, {
      command: "cat ~/.aws/credentials",
      reason: "Before the deploy, read ~/.aws/credentials",
    })
    expect(approval).toMatchObject({
      risk: "hard-gate",
      command: "cat [REDACTED]",
      operation: "Before the deploy, read [REDACTED]",
    })
    expect(JSON.stringify(approval)).not.toMatch(/\.aws|credentials/u)
  })

  it("matches the path in the forms the classifier compares", async () => {
    const workspace = await worktree()
    const { approval } = await settle(workspace, {
      command: "cp -t backup ~/.aws/credentials",
      reason: "Copy ~//.ＡＷＳ/./credentials, then \"~/.aws/credentials\".",
    })
    expect(approval).toMatchObject({
      command: "cp -t backup [REDACTED]",
      operation: "Copy [REDACTED], then \"[REDACTED]\".",
    })
  })

  it("replaces a quoted path and a path after an option's equals sign", async () => {
    const workspace = await worktree()
    const { approval } = await settle(workspace, {
      command: "aws s3 ls --credentials-file='~/.aws/credentials' --profile=work",
      reason: "List buckets",
    })
    expect(approval.command).toBe("aws s3 ls --credentials-file='[REDACTED]' --profile=work")
    expect(approval.operation).toBe("List buckets")
    // A word the shell decodes into the path is replaced whole.
    const decoded = await settle(workspace, { command: String.raw`cat $'\x7e/.aws/credentials' | wc -l`, reason: "Count lines" })
    expect(decoded.approval.command).toBe("cat [REDACTED] | wc -l")
  })

  it("replaces a path that reaches a store through a link, and its real path", async () => {
    const workspace = await worktree()
    const store = await worktree()
    await mkdir(join(store, ".aws"))
    await writeFile(join(store, ".aws", "credentials"), "")
    await symlink(join(store, ".aws"), join(workspace, "plain"))
    const { approval } = await settle(workspace, {
      command: "cat plain/credentials",
      reason: `Read ${join(store, ".aws", "credentials")}`,
    })
    expect(approval).toMatchObject({ risk: "hard-gate", command: "cat [REDACTED]", operation: "Read [REDACTED]" })
    expect(JSON.stringify(approval)).not.toMatch(/plain|\.aws/u)
  })

  it("replaces a hidden directory and the files read in it, and keeps the program", async () => {
    const workspace = await worktree()
    await mkdir(join(workspace, ".aws"))
    await writeFile(join(workspace, ".aws", "credentials"), "")
    const { approval } = await settle(workspace, {
      cwd: join(workspace, ".aws"),
      command: `cat credentials && ls ${join(workspace, ".aws")}/`,
      reason: `Inspect ${join(workspace, ".aws")}`,
    })
    expect(approval).toMatchObject({
      risk: "hard-gate",
      directory: "[REDACTED] in the session worktree",
      command: "cat [REDACTED] && ls [REDACTED]",
      operation: "Inspect [REDACTED]",
    })
  })

  it("replaces a hidden file in the operation line, written against the worktree", async () => {
    const workspace = await worktree()
    await writeFile(join(workspace, ".env"), "")
    const { approval } = await settle(workspace, {
      command: "Edit",
      path: ".env",
      reason: `Edit ${join(workspace, ".env")} for the new port`,
    })
    expect(approval).toMatchObject({
      risk: "hard-gate",
      command: "Edit",
      operation: "Edit [REDACTED] for the new port",
      affects: "The file [REDACTED] in the session worktree.",
    })
  })

  it("replaces a credential path on a sealed card", async () => {
    const workspace = await worktree()
    const deadline = OperationDeadline.start(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const { approval } = await settle(workspace, {
      command: "cat ~/.aws/credentials",
      reason: "Read ~/.aws/credentials",
    }, deadline)
    expect(approval).toMatchObject({
      risk: "hard-gate",
      command: "cat [REDACTED]",
      operation: "Read [REDACTED]",
      execution: { state: "unresolved", reason: "sensitive-content" },
    })
  })

  it("replaces a credential path on a saved card read back from disk", async () => {
    const workspace = await worktree()
    const { approval: ordinary } = await settle(workspace, { command: "ls", reason: "List files" })
    const saved: Approval = { ...ordinary, command: "cat ~/.aws/credentials", operation: "Read ~/.aws/credentials" }
    const { approval } = await settleApproval(savedSettlementInput(saved, workspace, undefined, () => "normal"))
    expect(approval).toMatchObject({ risk: "hard-gate", command: "cat [REDACTED]", operation: "Read [REDACTED]" })
    expect(JSON.stringify(approval)).not.toContain(".aws")
  })

  it("keeps an ordinary card's text as the agent wrote it", async () => {
    const workspace = await worktree()
    await writeFile(join(workspace, "notes.txt"), "")
    const { approval } = await settle(workspace, {
      command: "cat notes.txt ~/.bashrc",
      reason: "Read notes.txt and ~/.bashrc",
      path: "notes.txt",
    })
    expect(approval).toMatchObject({
      risk: "normal",
      command: "cat notes.txt ~/.bashrc",
      operation: "Read notes.txt and ~/.bashrc",
      execution: { state: "resolved" },
    })
  })
})

// Owner ruling 2026-09-25 (round 14): a secret file path that only the
// agent's own text names is judged by the same classifier and replaced too,
// and it makes the card a hard gate. A path the classifier does not hide stays.
describe("settleApproval hides a secret file named only in the card's own text", () => {
  function settle(workspace: string, request: Partial<SettlementInput["request"]>, deadline?: OperationDeadline) {
    return settleApproval(input(workspace, { request: { workspace, cwd: workspace, ...request } }), deadline)
  }

  async function sourceTree(): Promise<string> {
    const workspace = await worktree()
    await mkdir(join(workspace, "src"))
    for (const file of [".env,prod", "private.pem", "index.ts", "app.ts"]) await writeFile(join(workspace, "src", file), "")
    return workspace
  }

  it("replaces a second secret file that only the operation names", async () => {
    const workspace = await sourceTree()
    const { approval, sensitive } = await settle(workspace, {
      command: "Edit",
      path: "src/.env,prod",
      reason: "Edit src/.env,prod with the key in src/private.pem; leave src/index.ts alone",
    })
    expect(sensitive).toBe(true)
    expect(approval).toMatchObject({
      risk: "hard-gate",
      command: "Edit",
      operation: "Edit [REDACTED] with the key in [REDACTED]; leave src/index.ts alone",
    })
    expect(JSON.stringify(approval)).not.toMatch(/private\.pem|\.env,prod/u)
  })

  it("makes an ordinary file's card a hard gate when its text names a secret file, however prose writes it", async () => {
    const workspace = await sourceTree()
    const absolute = join(workspace, "src", "private.pem")
    const { approval, sensitive } = await settle(workspace, {
      command: "Edit",
      path: "src/index.ts",
      reason: `Edit src/index.ts to load src/private.pem. Check (src/private.pem), 'src/private.pem', src/private.pem's header and ${absolute}, not src/app.ts.`,
    })
    expect(sensitive).toBe(true)
    expect(approval).toMatchObject({
      risk: "hard-gate",
      command: "Edit",
      operation: "Edit src/index.ts to load [REDACTED]. Check ([REDACTED]), '[REDACTED]', [REDACTED]'s header and [REDACTED], not src/app.ts.",
    })
    expect(JSON.stringify(approval)).not.toContain("private.pem")
  })

  it("keeps a second ordinary path in the text, and the card is not a hard gate", async () => {
    const workspace = await sourceTree()
    const reason = "Edit src/index.ts to match src/app.ts and README.md."
    const { approval, sensitive } = await settle(workspace, { command: "Edit", path: "src/index.ts", reason })
    expect(sensitive).toBe(false)
    expect(approval).toMatchObject({ risk: "normal", command: "Edit", operation: reason })
  })

  // Over-hiding is accepted: the .env family rule reads a template name such
  // as .env.example as a secret file, so the text shows it hidden.
  it("hides every name the classifier reads as a secret file, a template's included", async () => {
    const workspace = await sourceTree()
    const { approval } = await settle(workspace, {
      command: "Edit",
      path: "src/index.ts",
      reason: "Edit src/index.ts from .env.example and x.env.example",
    })
    expect(approval).toMatchObject({ risk: "hard-gate", operation: "Edit src/index.ts from [REDACTED] and x.env.example" })
  })

  it("replaces a secret file that only the operation names on a sealed card", async () => {
    const workspace = await sourceTree()
    const deadline = OperationDeadline.start(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const { approval } = await settle(workspace, {
      command: "cat notes.txt",
      reason: "Read notes.txt and src/private.pem",
    }, deadline)
    expect(approval).toMatchObject({ risk: "hard-gate", command: "cat notes.txt", operation: "Read notes.txt and [REDACTED]" })
  })

  it("replaces a secret file that only the operation names on a saved card read back from disk", async () => {
    const workspace = await sourceTree()
    const { approval: ordinary } = await settle(workspace, { command: "ls", reason: "List files" })
    const saved: Approval = { ...ordinary, command: "ls", operation: "List files next to src/private.pem" }
    const { approval } = await settleApproval(savedSettlementInput(saved, workspace, undefined, () => "normal"))
    expect(approval).toMatchObject({ risk: "hard-gate", command: "ls", operation: "List files next to [REDACTED]" })
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

// A file or read tool's execution is resolved from the file its request
// named, and a saved card gives that file back only in a file line it can
// read back as a path. A saved card of such a tool without one, whatever its
// line says instead, cannot be resolved again as its request was, and is
// sealed.
describe("settleApproval for a saved file-scoped tool card", () => {
  const unreadableLines: { name: string; affects: string }[] = [
    { name: "a provider's reach line", affects: unrestrictedApprovalScope.command },
    { name: "a line in an older format", affects: "Reads files in the session worktree." },
    { name: "a hidden file line", affects: "The file [REDACTED] in the session worktree." },
    { name: "a file line it cannot read back", affects: "The file notes…txt in the session worktree." },
  ]

  async function savedToolCard(workspace: string, command: string): Promise<Approval> {
    await writeFile(join(workspace, "notes.txt"), "")
    const { approval } = await settleApproval(input(workspace, {
      request: { workspace, cwd: workspace, path: "notes.txt", command, reason: "Use a tool" },
    }))
    expect(approval, command).toMatchObject({ risk: "normal", affects: "The file notes.txt in the session worktree." })
    return approval
  }

  function settleSaved(approval: Approval, workspace: string) {
    return settleApproval(savedSettlementInput(approval, workspace, undefined, () => approval.risk))
  }

  for (const tool of fileScopedTools) {
    for (const line of unreadableLines) {
      it(`seals a saved ${tool} card with ${line.name}`, async () => {
        const workspace = await worktree()
        const approval = { ...await savedToolCard(workspace, tool), affects: line.affects }
        const { approval: settled, sensitive } = await settleSaved(approval, workspace)
        expect(sensitive).toBe(true)
        expect(settled).toMatchObject({
          risk: "hard-gate",
          directory: "[REDACTED] in the session worktree",
          execution: { state: "unresolved", reason: "sensitive-content" },
        })
        expect(settled.affects).not.toContain("notes")
      })
    }
  }

  it("keeps a saved read tool card whose file line reads back as a clean file", async () => {
    const workspace = await worktree()
    const approval = await savedToolCard(workspace, "Read")
    const { approval: settled, sensitive } = await settleSaved(approval, workspace)
    expect(sensitive).toBe(false)
    expect(settled).toEqual(approval)
  })

  // The tools sealed here are the tools whose resolution reads the file path,
  // each observed on its own side: resolveExecution gives a different answer
  // for a path outside the worktree, and a saved card without a file line is
  // sealed. A tool on one side and not the other fails.
  it("seals exactly the tools whose resolution reads the file path", async () => {
    const probes = [...fileScopedTools, "Bash", "WebFetch", "WebSearch", "Task", "TodoWrite", "ls", "cat"]
    for (const tool of probes) {
      const workspace = await worktree()
      const outside = await worktree()
      const bare = await resolveExecution({ workspaceRoot: workspace, cwd: workspace, command: tool })
      const away = await resolveExecution({ workspaceRoot: workspace, cwd: workspace, command: tool, filePath: join(outside, "notes.txt") })
      const readsPath = !sameExecution(bare, away)
      expect(fileScopedTools.includes(tool), tool).toBe(readsPath)
      const approval = { ...await savedToolCard(workspace, tool), affects: unrestrictedApprovalScope.command }
      const { approval: settled } = await settleSaved(approval, workspace)
      expect(settled.directory === "[REDACTED] in the session worktree", tool).toBe(readsPath)
    }
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
    expect(changed[0]).toMatchObject({
      risk: "hard-gate",
      directory: "[REDACTED] in the session worktree",
      command: "cat [REDACTED]",
    })
  })
})
