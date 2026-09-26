import { mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { pathHider, pathHiderStepLimit } from "./approval-path-text.js"
import { settleApproval } from "./approval-settlement.js"
import { commandOperands, textOperands } from "./credential-stores.js"
import { namesSecretPath } from "./permission-policy.js"
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

// Round 15: secret names that, read as keys, cost the matcher more than linear
// work held the daemon for seconds per request. Each shape is hidden whole
// within the step limit, and the card is a hard gate already.
describe("pathHider's work bound", () => {
  const fill = (unit: (index: number) => string, length: number): string => {
    let text = ""
    for (let index = 0; text.length < length; index += 1) text += unit(index)
    return text
  }
  const operation = (text: string) => textOperands(text).filter(namesSecretPath)
  const command = (text: string) => commandOperands(text).filter(namesSecretPath)
  const shapes = [
    { label: "an operation of s<i>/k<i>.pem joined by commas", text: `Edit src/index.ts with ${fill((index) => `s${index}/k${index}.pem,`, 2_048)}`, keys: operation },
    { label: "a command of s<i>/k<i>.pem joined by colons", text: `cat ${fill((index) => `s${index}/k${index}.pem:`, 2_048)}`, keys: command },
    { label: "a.pem joined by commas", text: fill(() => "a.pem,", 8_192), keys: operation },
    { label: ".env( repeated", text: fill(() => ".env(", 8_192), keys: operation },
    { label: "a/a.pem/ repeated", text: fill(() => "a/a.pem/", 8_192), keys: operation },
    {
      label: "words shorter than a path, each costly",
      text: Array.from({ length: 8 }, (_, word) => fill((index) => `s${word}x${index}/k${index}.pem,`, 2_000)).join(" "),
      keys: operation,
    },
  ]

  it.each(shapes)("hides $label whole within the step limit", ({ text, keys }) => {
    const { text: shown, steps } = pathHider(keys(text)).measure(text)
    expect(shown).toBe("[REDACTED]")
    expect(steps).toBeLessThanOrEqual(pathHiderStepLimit)
  })

  it("hides a line whole when a hidden path is longer than any real path", () => {
    const name = `${"a".repeat(5_000)}.pem`
    const text = `Read ${name} now`
    const { text: shown, steps } = pathHider(operation(text)).measure(text)
    expect(shown).toBe("[REDACTED]")
    expect(steps).toBeLessThanOrEqual(pathHiderStepLimit)
  })

  it("keeps an ordinary line within the bound", () => {
    const text = "Edit src/.env and src/index.ts, then src/app.ts"
    const { text: shown, steps } = pathHider(["src/.env"]).measure(text)
    expect(shown).toBe("Edit [REDACTED] and src/index.ts, then src/app.ts")
    expect(steps).toBeLessThanOrEqual(pathHiderStepLimit)
  })
})
