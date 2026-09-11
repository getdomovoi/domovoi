import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import test from "node:test"

import {
  checkTickCitations,
  citedShas,
  collectTicks,
  pruneAllowlist,
  seedAllowlist,
} from "./tick-citations.mjs"

// Registered where the directory is made, not after the assertions: a failing
// expectation skips everything below it, and the directory outlives the run.
// A real repository with one commit, because the citations under test are
// checked for reachability from HEAD. A plain directory cannot answer that, and
// until this was a repository every sha in these tests was silently skipped —
// the suite proved nothing about the half of the checker it exists for.
async function scratchRepository(t, roadmap, workSplit = "") {
  const root = await mkdtemp(join(tmpdir(), "domovoi-ticks-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" })
  git("init", "--quiet", "--initial-branch", "main")
  git("config", "user.email", "test@example.invalid")
  git("config", "user.name", "test")
  git("commit", "--quiet", "--allow-empty", "-m", "root")
  const cited = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  await mkdir(join(root, "scripts"), { recursive: true })
  // The fixtures are written before the sha exists, so they name it CITED and
  // the real one is substituted here.
  const withSha = (text) => text.replaceAll("CITED", cited)
  await writeFile(join(root, "ROADMAP.md"), withSha(roadmap))
  await writeFile(join(root, "WORK-SPLIT.md"), withSha(workSplit))
  return { root, cited }
}

test("reads a citation from the line that continues the tick", () => {
  const ticks = collectTicks([
    "- [x] Token and cost telemetry normalized for Anthropic",
    "      (1b683d6 · session totals 76d11c2 · cached-token fold 33b2737)",
    "- [ ] OpenCode undercounts",
  ].join("\n"))
  assert.equal(ticks.length, 1)
  assert.deepEqual(citedShas(ticks[0].body), ["1b683d6", "76d11c2", "33b2737"])
})

// The sub-items under a cited tick are its open work, not its evidence. If they
// counted as continuation, one citation on the parent would silently satisfy
// every box nested beneath it.
test("does not let a nested item borrow the parent's citation", () => {
  const ticks = collectTicks([
    "- [x] The parent claim (1b683d6)",
    "  - [x] A nested claim with nothing behind it",
  ].join("\n"))
  assert.deepEqual(ticks.map(({ text }) => text), [
    "The parent claim (1b683d6)",
    "A nested claim with nothing behind it",
  ])
  assert.deepEqual(citedShas(ticks[1].body), [])
})

// The test above uses "-" for both lines, so it passed while the parser only knew
// "-" and "*". Markdown allows "+" and ordered items too, and a tick written that
// way collected nothing at all: not a tick, so never checked, and not a list item
// either, so folded into whatever tick sat above it. Both halves fail open.
test("collects a tick under every bullet Markdown allows", () => {
  const ticks = collectTicks([
    "- [x] Dash",
    "* [x] Star",
    "+ [x] Plus",
    "1. [x] Ordered with a period",
    "2) [x] Ordered with a parenthesis",
  ].join("\n"))
  assert.deepEqual(ticks.map(({ text }) => text), [
    "Dash", "Star", "Plus", "Ordered with a period", "Ordered with a parenthesis",
  ])
})

// The sharper half. The child was not recognised as opening a list, so its line
// was appended to the parent's body and the parent passed on the child's sha.
test("does not let a plus-bullet child pay for an uncited parent", () => {
  const ticks = collectTicks([
    "- [x] The parent claim with nothing behind it",
    "  + [x] A nested claim (1b683d6)",
  ].join("\n"))
  assert.equal(ticks.length, 2)
  assert.deepEqual(citedShas(ticks[0].body), [])
  assert.deepEqual(citedShas(ticks[1].body), ["1b683d6"])
})

test("reads a file path in parentheses as prose rather than a citation", () => {
  assert.deepEqual(citedShas("Usage is stamped at write time (`server.ts:6903`, switch at `5835`)"), [])
})

// Check the check: an uncited tick has to fail before a pass means anything.
// The branch b12a784 added in answer to the major review finding, and nothing
// exercised it. A fix for the most serious finding on a pull request, left
// untested, is the same defect one level up: the check and the thing checked
// moving together. Both tests below use a citation that *would* resolve, so a
// failure can only come from the skip path and never from a bad sha.
test("fails in a shallow clone rather than passing a citation it cannot check", async (t) => {
  const origin = await mkdtemp(join(tmpdir(), "domovoi-ticks-origin-"))
  t.after(() => rm(origin, { recursive: true, force: true }))
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" })
  git(origin, "init", "--quiet", "--initial-branch", "main")
  git(origin, "config", "user.email", "test@example.invalid")
  git(origin, "config", "user.name", "test")
  git(origin, "commit", "--quiet", "--allow-empty", "-m", "first")
  git(origin, "commit", "--quiet", "--allow-empty", "-m", "second")

  const root = await mkdtemp(join(tmpdir(), "domovoi-ticks-shallow-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${origin}`, root], { stdio: "ignore" })
  assert.equal(
    execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, encoding: "utf8" }).trim(),
    "true",
    "the fixture has to be genuinely shallow or this test proves nothing",
  )

  // Reachable from HEAD in this very clone, so the only thing that can fail is
  // the shallow check itself.
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  await mkdir(join(root, "scripts"), { recursive: true })
  await writeFile(join(root, "scripts", "tick-citations-allowlist.json"), `${JSON.stringify({ exempt: {} })}\n`)
  await writeFile(join(root, "ROADMAP.md"), `# roadmap\n\n- [x] Cited work (${head})\n`)
  await writeFile(join(root, "WORK-SPLIT.md"), "")

  const result = await checkTickCitations(root)

  assert.equal(result.ok, false)
  assert.equal(result.shallow, true)
  assert.match(result.failures[0], /cannot check whether .* is an ancestor of this branch/)
  assert.match(result.failures[0], /fetch-depth: 0/)
})

test("fails when git cannot answer at all rather than passing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "domovoi-ticks-nogit-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "scripts"), { recursive: true })
  await writeFile(join(root, "scripts", "tick-citations-allowlist.json"), `${JSON.stringify({ exempt: {} })}\n`)
  await writeFile(join(root, "ROADMAP.md"), "# roadmap\n\n- [x] Cited work (1b683d6)\n")
  await writeFile(join(root, "WORK-SPLIT.md"), "")

  const result = await checkTickCitations(root)

  assert.equal(result.ok, false)
  assert.equal(result.shallow, true)
  assert.match(result.failures[0], /cannot check whether 1b683d6 is an ancestor/)
})

test("fails an uncited tick and names where it is", async (t) => {
  const { root, cited } = await scratchRepository(t, [
    "# roadmap",
    "",
    "- [x] Cited work (CITED)",
    "- [x] Uncited work",
  ].join("\n"))
  await writeFile(join(root, "scripts", "tick-citations-allowlist.json"), `${JSON.stringify({ exempt: {} })}\n`)

  const result = await checkTickCitations(root)

  assert.equal(result.ok, false)
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /^ROADMAP\.md:4: \[x\] with no commit citation/)
})

test("passes when every tick cites, in both files", async (t) => {
  const { root, cited } = await scratchRepository(t, 
    "- [x] Roadmap work (CITED)\n",
    "- [x] Plan work (CITED)\n",
  )
  await writeFile(join(root, "scripts", "tick-citations-allowlist.json"), `${JSON.stringify({ exempt: {} })}\n`)

  const result = await checkTickCitations(root)

  assert.deepEqual(result.failures, [])
  assert.equal(result.ok, true)
})

test("exempts a seeded tick and stops exempting it once it cites", async (t) => {
  const { root, cited } = await scratchRepository(t, "- [x] Older work with no citation\n")
  const seeded = await seedAllowlist(root)
  assert.equal(seeded, 1)
  assert.equal((await checkTickCitations(root)).ok, true)

  await writeFile(join(root, "ROADMAP.md"), `- [x] Older work with no citation (${cited})\n`)
  const graduated = await checkTickCitations(root)

  assert.equal(graduated.ok, false)
  assert.match(graduated.failures[0], /cited now, still listed in/)
})

// The list shrinking is the whole mechanism. An exemption that outlives its
// tick is an exemption nobody can see the shape of.
test("pruning drops an exemption that has been cited and keeps one that has not", async (t) => {
  const { root, cited } = await scratchRepository(t, [
    "- [x] Cited since seeding",
    "- [x] Still waiting",
  ].join("\n"))
  await seedAllowlist(root)
  await writeFile(join(root, "ROADMAP.md"), [
    `- [x] Cited since seeding (${cited})`,
    "- [x] Still waiting",
  ].join("\n"))

  const { removed, remaining } = await pruneAllowlist(root)

  assert.equal(removed, 1)
  assert.equal(remaining, 1)
  assert.equal((await checkTickCitations(root)).ok, true)
  const stored = JSON.parse(await readFile(join(root, "scripts", "tick-citations-allowlist.json"), "utf8"))
  assert.deepEqual(stored.exempt["ROADMAP.md"], ["Still waiting"])
})

// Seeding twice would re-exempt everything the list had shed, which is the same
// failure as regenerating a digest in the commit it covers.
test("refuses to seed over an existing allowlist", async (t) => {
  const { root, cited } = await scratchRepository(t, "- [x] Older work\n")
  await seedAllowlist(root)
  await assert.rejects(seedAllowlist(root), /already exists/)
})

test("fails a missing allowlist rather than passing with nothing to check against", async (t) => {
  const { root, cited } = await scratchRepository(t, "- [x] Cited work (1b683d6)\n")
  const result = await checkTickCitations(root)
  assert.equal(result.ok, false)
  assert.match(result.failures[0], /is missing/)
})

// The check exists to stop a green run that proved nothing, and it had one of
// its own: a shallow clone cannot answer whether a sha is an ancestor, and
// reporting that while exiting zero is the same defect wearing the checker's
// clothes. Unverifiable is a failure now. Verified against a real shallow
// clone of this repository: exit 1 there, exit 0 with full history.
test("fails when it cannot check reachability rather than passing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "domovoi-ticks-shallow-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "scripts"), { recursive: true })
  await writeFile(join(root, "ROADMAP.md"), "- [x] Cited work (1b683d6)\n")
  await writeFile(join(root, "scripts", "tick-citations-allowlist.json"), `${JSON.stringify({ exempt: {} })}\n`)

  // Not a git repository at all, which is the same answer as a shallow one:
  // the probe cannot run, so reachability is unknown.
  const result = await checkTickCitations(root)

  assert.equal(result.ok, false)
  assert.match(result.failures[0], /cannot check whether 1b683d6 is an ancestor of this branch/)
  assert.match(result.failures[0], /fetch-depth: 0/)
})
