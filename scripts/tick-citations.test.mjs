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

test("reads a file path in parentheses as prose rather than a citation", () => {
  assert.deepEqual(citedShas("Usage is stamped at write time (`server.ts:6903`, switch at `5835`)"), [])
})

// Check the check: an uncited tick has to fail before a pass means anything.
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
