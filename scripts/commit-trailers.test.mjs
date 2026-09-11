import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { baseRef, checkCommitTrailers, offendingLines, withoutAttribution } from "./commit-trailers.mjs"

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

// The first version returned ok on every git failure, which is the defect
// tick-citations.mjs had already been fixed for. A gate that cannot see the
// range has to say so; these are the cases where it cannot see it.
test("fails in a shallow clone rather than passing the commits it cannot read", async (t) => {
  const origin = await mkdtemp(join(tmpdir(), "domovoi-trailers-origin-"))
  t.after(() => rm(origin, { recursive: true, force: true }))
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" })
  git(origin, "init", "--quiet", "--initial-branch", "main")
  git(origin, "config", "user.email", "test@example.invalid")
  git(origin, "config", "user.name", "test")
  git(origin, "commit", "--quiet", "--allow-empty", "-m", "first")
  git(origin, "commit", "--quiet", "--allow-empty", "-m", "second")

  const root = await mkdtemp(join(tmpdir(), "domovoi-trailers-shallow-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${origin}`, root], { stdio: "ignore" })

  const result = await checkCommitTrailers(root)
  assert.equal(result.ok, false)
  assert.match(result.failures[0], /shallow clone/)
  assert.match(result.failures[0], /fetch-depth: 0/)
})

// The second version fell back to local main on any origin/main error. With a
// forbidden commit below the tip and local main already at the tip, that
// narrowed the range to the clean tip alone and passed. Found by Codex on the
// peer review of this branch, by injecting the error rather than reading the
// code.
test("refuses when origin/main cannot be read instead of narrowing the range to main", async () => {
  const git = async (args) => {
    if (args.includes("origin/main")) throw Object.assign(new Error("EIO"), { code: "EIO" })
    return "0123456789abcdef0123456789abcdef01234567"
  }
  await assert.rejects(baseRef(git), { code: "EIO" })
})

test("moves on from a candidate that does not exist, and only from that", async () => {
  const absent = Object.assign(new Error("absent"), { code: 1 })
  const git = async (args) => {
    if (args.includes("origin/main")) throw absent
    return args.includes("main") ? "base" : "head"
  }
  assert.deepEqual(await baseRef(git), { range: "main..HEAD", named: "main" })
})

test("fails where git cannot answer at all rather than passing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "domovoi-trailers-nogit-"))
  t.after(() => rm(root, { recursive: true, force: true }))

  const result = await checkCommitTrailers(root)
  assert.equal(result.ok, false)
  assert.equal(result.checked, 0)
  assert.match(result.failures[0], /cannot check commit messages/)
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
