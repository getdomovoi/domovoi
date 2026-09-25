import { mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { settleApproval } from "./approval-settlement.js"
import { removeScratchDirectories } from "./test-scratch.js"
import {
  cardCommand,
  cardOperation,
  cardTextFailures,
  createHiddenFile,
  hiddenNamePaths,
  hiddenNameRun,
} from "./test-hidden-names.js"

const scratch: string[] = []
afterEach(async () => {
  await removeScratchDirectories(scratch)
})

async function worktree(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "domovoi-path-text-")))
  scratch.push(directory)
  return directory
}

// Round 13: a hidden file name that holds a comma stayed in the card's text,
// because the text was split into words before it was matched. Every hidden
// file name, whatever characters it holds, is replaced in the card's command
// and operation lines wherever the text writes it, and the text around it and
// the paths the card does not hide stay.
describe("a hidden file name in a settled card's own text", () => {
  it("is replaced however the text writes it, and the rest of the text stays", async () => {
    const run = hiddenNameRun(24)
    const failures: string[] = []
    let refused = 0
    for (const [index, path] of hiddenNamePaths(run).entries()) {
      const workspace = await worktree()
      if (!await createHiddenFile(workspace, path)) {
        refused += 1
        continue
      }
      const forms = [path, join(workspace, ...path.split("/"))]
      const hidden = forms.map(() => "[REDACTED]")
      const { approval } = await settleApproval({
        approval: {
          id: `approval-path-text-${index}`,
          revision: 0,
          sessionId: "session-path-text",
          machine: "machine",
          agent: "claude-code / sonnet",
          mode: "build",
          estimatedDuration: "Unknown",
          checkpoint: "unavailable",
          requestedAt: "2026-09-25T00:00:00.000Z",
        },
        request: { workspace, cwd: workspace, path, command: cardCommand(forms), reason: cardOperation(forms) },
        scope: undefined,
        execution: "resolve",
        risk: () => "normal",
      })
      const label = `case ${index} ${JSON.stringify(path)}`
      if (approval.risk !== "hard-gate") failures.push(`${label} is not a hard gate`)
      failures.push(
        ...cardTextFailures({ label: `${label} operation`, shown: approval.operation, expected: cardOperation(hidden), forms, path }),
        ...cardTextFailures({ label: `${label} command`, shown: approval.command, expected: cardCommand(hidden), forms, path }),
      )
    }
    expect(failures, `seed ${run.seed}, ${run.cases} cases, ${refused} names refused by the filesystem`).toEqual([])
  })
})
