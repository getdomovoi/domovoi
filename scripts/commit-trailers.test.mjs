import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { checkCommitTrailers, offendingLines, withoutAttribution } from "./commit-trailers.mjs"

test("rejects the trailer that was added 33 times against a standing rule", () => {
  const found = offendingLines("fix: something\n\nClaude-Session: https://claude.ai/code/session_01HX\n")
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 3)
})

test("rejects the other shapes assistant attribution arrives in", () => {
  for (const line of [
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "Co-authored-by: Codex <codex@example.invalid>",
    "Generated-By: some-tool",
    "Authored-With: a model",
    "https://claude.ai/code/session_01HX",
  ]) {
    assert.equal(offendingLines(`feat: x\n\n${line}\n`).length, 1, line)
  }
})

// The rule is about attribution, not about the word. A human co-author keeps
// working, and a message that discusses the rule is not a violation of it.
test("leaves a human co-author and prose about the rule alone", () => {
  assert.deepEqual(offendingLines("feat: x\n\nCo-Authored-By: A Person <p@example.invalid>\n"), [])
  assert.deepEqual(offendingLines("docs: explain why Claude-Session trailers are banned\n"), [])
})

// The harness appends the trailer itself, so rejecting at commit time would mean
// amending every commit. The hook strips; these pin that it removes the line, the
// blank line it leaves behind, and nothing else.
test("strips the attribution and the separator it leaves behind", () => {
  const { message, removed } = withoutAttribution(
    "fix: something\n\nA body paragraph.\n\nClaude-Session: https://claude.ai/code/session_01HX\n",
  )
  assert.equal(message, "fix: something\n\nA body paragraph.\n")
  assert.equal(removed.length, 1)
  assert.equal(removed[0].name, "Claude-Session")
})

test("leaves a message with no attribution byte-identical", () => {
  const original = "fix: something\n\nA body paragraph.\n"
  const { message, removed } = withoutAttribution(original)
  assert.equal(message, original)
  assert.deepEqual(removed, [])
})

test("strips a human co-author never, and an assistant one always", () => {
  const human = "feat: x\n\nCo-Authored-By: A Person <p@example.invalid>\n"
  assert.equal(withoutAttribution(human).message, human)
  assert.equal(withoutAttribution("feat: x\n\nCo-Authored-By: Claude <n@anthropic.com>\n").removed.length, 1)
})

// Check the check: a clean range has to pass before a failing one means anything.
test("passes a branch whose commits carry no attribution", async (t) => {
  const { root } = await scratchBranch(t, ["first", "second"])
  const result = await checkCommitTrailers(root)
  assert.equal(result.ok, true)
  assert.equal(result.checked, 2)
})

test("fails the branch and names the commit and the line", async (t) => {
  const { root } = await scratchBranch(t, ["first", "second\n\nClaude-Session: https://claude.ai/code/session_01HX"])
  const result = await checkCommitTrailers(root)
  assert.equal(result.ok, false)
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /message line 3: Claude-Session is not allowed/)
})

async function scratchBranch(t, messages) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-trailers-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" })
  git("init", "--quiet", "--initial-branch", "main")
  git("config", "user.email", "test@example.invalid")
  git("config", "user.name", "test")
  git("commit", "--quiet", "--allow-empty", "-m", "root")
  git("checkout", "--quiet", "-b", "work")
  for (const [index, message] of messages.entries()) {
    await writeFile(join(root, `file-${index}`), `${index}\n`)
    git("add", "-A")
    git("commit", "--quiet", "-m", message)
  }
  return { root }
}
