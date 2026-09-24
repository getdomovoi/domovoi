import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// An approval reaches the snapshot only through the settlement ledger: the one
// place that pushes or replaces an approval, and only one that settleApproval
// made. Everywhere else may read approvals and remove them, never write one.

const sourceDirectory = dirname(fileURLToPath(import.meta.url))

// The ledger itself, and the store's load and save copies, which run before
// the daemon settles what it loaded.
const owners = new Set(["approval-settlement.ts", "store.ts", "workspace-redaction.ts"])

const writes: readonly { rule: string; pattern: RegExp }[] = [
  { rule: "adds or reorders approvals", pattern: /\bapprovals\s*\.\s*(?:push|unshift|splice|fill|copyWithin|sort|reverse)\s*\(/u },
  { rule: "writes an approval by index", pattern: /\bapprovals\s*\[[^\]]*\]\s*(?:\.\s*\w+\s*)?=(?!=)/u },
  // Assigning the list is allowed only to remove entries from it, or all.
  { rule: "assigns the approval list", pattern: /\.approvals\s*=(?!=)(?!\s*[\w.#?]+\.approvals\.filter\()(?!\s*\[\]\s*$)/u },
  // A field the settlement derives, written on a held approval.
  { rule: "writes a settled field", pattern: /\b(?:approval|current|pending|candidateApproval|held|waiting)\s*\.\s*(?:risk|directory|affects|network|execution|command|operation)\s*=(?!=)/u },
]

function sources(): { file: string; lines: string[] }[] {
  return readdirSync(sourceDirectory)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.startsWith("test-") && !owners.has(file))
    .map((file) => ({ file, lines: readFileSync(join(sourceDirectory, file), "utf8").split("\n") }))
}

describe("approval writes", () => {
  it("go through the settlement ledger in every daemon source", () => {
    const found = sources().flatMap(({ file, lines }) => lines.flatMap((line, index) => (
      writes.filter(({ pattern }) => pattern.test(line)).map(({ rule }) => `${file}:${index + 1}: ${rule}: ${line.trim()}`)
    )))
    expect(found).toEqual([])
  })

  it("catches each kind of write it forbids", () => {
    const probes = [
      "this.#snapshot.approvals.push(approval)",
      "snapshot.approvals.unshift(copy)",
      "this.#snapshot.approvals[0] = approval",
      "this.#snapshot.approvals[index].risk = \"normal\"",
      "this.#snapshot.approvals = restored?.approvals ?? []",
      "candidate.approvals = [...candidate.approvals, approval]",
      "current.risk = \"hard-gate\"",
      "approval.execution = currentExecution",
    ]
    expect(probes.filter((probe) => !writes.some(({ pattern }) => pattern.test(probe)))).toEqual([])
    for (const removal of ["candidate.approvals = candidate.approvals.filter((a) => a.id !== id)", "this.#snapshot.approvals = []"]) {
      expect(writes.some(({ pattern }) => pattern.test(removal))).toBe(false)
    }
  })
})
