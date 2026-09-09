import assert from "node:assert/strict"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const repositoryRoot = new URL("..", import.meta.url).pathname

import {
  checkRevisions,
  compareDigests,
  designDigests,
  designFiles,
  writeRevisions,
} from "./design-revision.mjs"

async function scratchRepository() {
  const root = await mkdtemp(join(tmpdir(), "domovoi-design-"))
  await mkdir(join(root, "design", "design_handoff_domovoi", "designs"), { recursive: true })
  await writeFile(join(root, "design", "design_handoff_domovoi", "README.md"), "# handoff\n")
  await writeFile(join(root, "design", "design_handoff_domovoi", "designs", "Domovoi Desktop.dc.html"), "<x-dc>a</x-dc>\n")
  return root
}

test("lists every tracked design file in a stable order", async () => {
  const root = await scratchRepository()
  assert.deepEqual(await designFiles(root), [
    "design/design_handoff_domovoi/README.md",
    "design/design_handoff_domovoi/designs/Domovoi Desktop.dc.html",
  ])
  await rm(root, { recursive: true, force: true })
})

test("records a digest and byte count for each file", async () => {
  const root = await scratchRepository()
  const record = await writeRevisions(root)
  const stored = JSON.parse(await readFile(join(root, "design", "REVISIONS.json"), "utf8"))
  assert.equal(stored.source.projectId, "a3b4404e-4d0c-451e-8dd2-203116a76c06")
  assert.match(stored.recordedOn, /^\d{4}-\d{2}-\d{2}$/)
  const entry = record.files["design/design_handoff_domovoi/README.md"]
  assert.equal(entry.bytes, 10)
  assert.match(entry.sha256, /^[0-9a-f]{64}$/)
  await rm(root, { recursive: true, force: true })
})

test("passes the check when nothing under design has moved", async () => {
  const root = await scratchRepository()
  await writeRevisions(root)
  assert.deepEqual(await checkRevisions(root), { ok: true })
  await rm(root, { recursive: true, force: true })
})

test("fails the check when a signed file is edited locally", async () => {
  const root = await scratchRepository()
  await writeRevisions(root)
  await writeFile(join(root, "design", "design_handoff_domovoi", "README.md"), "# handoff\nlocal note\n")
  const result = await checkRevisions(root)
  assert.equal(result.ok, false)
  assert.match(result.reason, /changed: design\/design_handoff_domovoi\/README\.md/)
  assert.match(result.reason, /never edited here/)
  await rm(root, { recursive: true, force: true })
})

test("names a file that appeared or disappeared", async () => {
  const root = await scratchRepository()
  await writeRevisions(root)
  await writeFile(join(root, "design", "design_handoff_domovoi", "designs", "Domovoi Web.dc.html"), "<x-dc>b</x-dc>\n")
  await rm(join(root, "design", "design_handoff_domovoi", "README.md"))
  const result = await checkRevisions(root)
  assert.equal(result.ok, false)
  assert.match(result.reason, /added:   design\/design_handoff_domovoi\/designs\/Domovoi Web\.dc\.html/)
  assert.match(result.reason, /removed: design\/design_handoff_domovoi\/README\.md/)
  await rm(root, { recursive: true, force: true })
})

test("reports a missing record rather than treating it as a match", async () => {
  const root = await scratchRepository()
  const result = await checkRevisions(root)
  assert.equal(result.ok, false)
  assert.match(result.reason, /REVISIONS\.json is missing/)
  await rm(root, { recursive: true, force: true })
})

test("compares digests without caring about key order", () => {
  const recorded = { a: { sha256: "1" }, b: { sha256: "2" } }
  const current = { b: { sha256: "2" }, a: { sha256: "1" } }
  assert.deepEqual(compareDigests(recorded, current), { changed: [], added: [], removed: [] })
})

test("digests are stable across two reads of the same tree", async () => {
  const root = await scratchRepository()
  assert.deepEqual(await designDigests(root), await designDigests(root))
  await rm(root, { recursive: true, force: true })
})

// Stated as a property rather than a list. An exclusion set is an enumeration,
// and the next person adding a note to design/ would have no way to know they
// had to edit it: their file would be digested, the digests regenerated in the
// same commit, and nothing would object.
test("digests every file under design/ except the record itself", async () => {
  const digested = new Set(await designFiles())
  const present = []
  async function walk(directory) {
    for (const entry of await readdir(join(repositoryRoot, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) present.push(path)
    }
  }
  await walk("design")
  const undigested = present.filter((file) => !digested.has(file))
  assert.deepEqual(undigested, ["design/REVISIONS.json"], "design/ holds signed sources and its own manifest, nothing authored here")
})

