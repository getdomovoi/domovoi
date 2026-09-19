import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { checkConformance, designCopy } from "./design-conformance.mjs"

// A small design in the .dc.html shape: literal copy in the template, copy
// under aria-label, a binding that is not copy, and sample data.
const design = `<x-dc>
<helmet></helmet>
<div>
  <span role="img" aria-label="Domovoi"></span>
  <div>Hide sessions</div>
  <div>{{ machineName }}</div>
  <div>acme-api · main</div>
  <div onClick="{{ jump }}">Jump to latest</div>
</div>
</x-dc>
<script>const x = "not copy";</script>`

async function fixture(inventory, source = "export const label = \"Hide sessions\"\nexport const mark = \"Domovoi\"\n") {
  const root = await mkdtemp(join(tmpdir(), "design-conformance-"))
  await mkdir(join(root, "design"), { recursive: true })
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(join(root, "design", "Surface.dc.html"), design)
  await writeFile(join(root, "src", "chrome.tsx"), source)
  const sha256 = createHash("sha256").update(design).digest("hex")
  const record = {
    design: "design/Surface.dc.html",
    sha256,
    derivedOn: "2026-09-18",
    sources: ["src/**/*.tsx"],
    sample: ["acme-api · main"],
    elements: [],
    ...inventory,
  }
  await writeFile(join(root, "inventory.json"), JSON.stringify(record))
  return { root, record }
}

test("template copy is every literal text node and aria-label, not bindings or script", () => {
  assert.deepEqual(designCopy(design), ["Domovoi", "Hide sessions", "acme-api · main", "Jump to latest"])
})

test("a built element whose evidence is in source, a claimed sample and a missing element pass", async () => {
  const { root } = await fixture({
    elements: [
      { id: "titlebar.mark", name: "The mark", where: "titlebar", copy: ["Domovoi"], evidence: ["Domovoi"] },
      { id: "titlebar.drawer", name: "Drawer toggle", where: "titlebar", copy: ["Hide sessions"], evidence: ["Hide sessions"] },
      { id: "thread.jump", name: "Jump pill", where: "above composer", copy: ["Jump to latest"], missing: { since: "2026-09-18", reason: "chrome pass unstarted" } },
    ],
  })
  const result = await checkConformance(root, "inventory.json")
  assert.deepEqual(result.failures, [])
  assert.equal(result.missing.length, 1)
})

test("copy in the design that no element claims fails, so a design change nothing implements is red", async () => {
  const { root } = await fixture({
    elements: [
      { id: "titlebar.mark", name: "The mark", where: "titlebar", copy: ["Domovoi"], evidence: ["Domovoi"] },
      { id: "titlebar.drawer", name: "Drawer toggle", where: "titlebar", copy: ["Hide sessions"], evidence: ["Hide sessions"] },
    ],
  })
  const result = await checkConformance(root, "inventory.json")
  assert.ok(result.failures.some((line) => line.includes("unclaimed copy") && line.includes("Jump to latest")))
})

test("a changed design digest fails until the inventory is re-derived", async () => {
  const { root } = await fixture({ sha256: "0".repeat(64), elements: [
    { id: "titlebar.mark", name: "The mark", where: "titlebar", copy: ["Domovoi", "Hide sessions", "Jump to latest"], evidence: ["Domovoi"] },
  ] })
  const result = await checkConformance(root, "inventory.json")
  assert.ok(result.failures.some((line) => line.includes("digest")))
})

test("a built element whose evidence is not in source fails, and a missing one whose evidence appears fails the other way", async () => {
  const { root } = await fixture({
    elements: [
      { id: "titlebar.mark", name: "The mark", where: "titlebar", copy: ["Domovoi"], evidence: ["Domovoi mark component"] },
      { id: "titlebar.drawer", name: "Drawer toggle", where: "titlebar", copy: ["Hide sessions", "Jump to latest"], evidence: ["Hide sessions"], missing: { since: "2026-09-18", reason: "not yet" } },
    ],
  })
  const result = await checkConformance(root, "inventory.json")
  assert.ok(result.failures.some((line) => line.includes("titlebar.mark") && line.includes("Domovoi mark component")))
  assert.ok(result.failures.some((line) => line.includes("titlebar.drawer") && line.includes("no longer missing")))
})

test("claimed copy the design no longer draws fails, so the inventory cannot outlive the design", async () => {
  const { root } = await fixture({
    elements: [
      { id: "titlebar.mark", name: "The mark", where: "titlebar", copy: ["Domovoi", "Hide sessions", "Jump to latest", "Old label"], evidence: ["Domovoi"] },
    ],
  })
  const result = await checkConformance(root, "inventory.json")
  assert.ok(result.failures.some((line) => line.includes("stale copy") && line.includes("Old label")))
})

test("a blocked element is reported apart from missing and needs a dated reason", async () => {
  const { root } = await fixture({
    elements: [
      { id: "titlebar.mark", name: "The mark", where: "titlebar", copy: ["Domovoi", "Hide sessions"], evidence: ["Domovoi"] },
      { id: "thread.jump", name: "Jump pill", where: "above composer", copy: ["Jump to latest"], blocked: { since: "2026-09-18", needs: "protocol", reason: "no wire field" } },
    ],
  })
  const result = await checkConformance(root, "inventory.json")
  assert.deepEqual(result.failures, [])
  assert.equal(result.blocked.length, 1)
})

test("a partial element needs its presence in source and its evidence not yet all there", async () => {
  const { root } = await fixture({
    elements: [
      { id: "titlebar.mark", name: "The mark", where: "titlebar", copy: ["Domovoi", "Jump to latest"], evidence: ["Domovoi"] },
      { id: "titlebar.drawer", name: "Drawer toggle", where: "titlebar", copy: ["Hide sessions"], presence: ["Hide sessions"], evidence: ["Sessions · badge"], partial: { since: "2026-09-18", reason: "text trigger, no badge" } },
    ],
  })
  const result = await checkConformance(root, "inventory.json")
  assert.deepEqual(result.failures, [])
  assert.equal(result.partial.length, 1)

  const gone = await fixture({
    elements: [
      { id: "titlebar.mark", name: "The mark", where: "titlebar", copy: ["Domovoi", "Jump to latest", "Hide sessions"], evidence: ["Domovoi"] },
      { id: "x.gone", name: "Gone", where: "nowhere", presence: ["never in source"], evidence: ["also never"], partial: { since: "2026-09-18", reason: "r" } },
      { id: "x.done", name: "Done", where: "nowhere", presence: ["Domovoi"], evidence: ["Hide sessions"], partial: { since: "2026-09-18", reason: "r" } },
    ],
  })
  const second = await checkConformance(gone.root, "inventory.json")
  assert.ok(second.failures.some((line) => line.includes("x.gone") && line.includes("missing, not partial")))
  assert.ok(second.failures.some((line) => line.includes("x.done") && line.includes("no longer partial")))
})

test("absent-in-file evidence holds when the named file lacks the string, and a human-read note must name an element", async () => {
  const { root } = await fixture({
    elements: [
      { id: "titlebar.mark", name: "The mark", where: "titlebar", copy: ["Domovoi", "Jump to latest"], evidence: ["Domovoi", { absent: "Hide sessions", in: "src/other.tsx" }] },
      { id: "titlebar.drawer", name: "Drawer toggle", where: "titlebar", copy: ["Hide sessions"], evidence: ["Hide sessions", { absent: "Hide sessions", in: "src/chrome.tsx" }] },
    ],
    humanRead: [{ id: "titlebar.mark", since: "2026-09-18", note: "position not verified" }, { id: "nope", since: "2026-09-18", note: "x" }],
  })
  await writeFile(join(root, "src", "other.tsx"), "export const x = 1\n")
  const result = await checkConformance(root, "inventory.json")
  assert.ok(result.failures.some((line) => line.includes("titlebar.drawer") && line.includes("absent from src/chrome.tsx")))
  assert.ok(!result.failures.some((line) => line.includes("titlebar.mark:")))
  assert.ok(result.failures.some((line) => line.includes("humanRead names nope")))
  assert.equal(result.humanRead.length, 2)
})
