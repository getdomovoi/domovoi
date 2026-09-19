import { createHash } from "node:crypto"
import { readFile, readdir, stat } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
const inventoryDirectory = "docs/design-conformance"

// Design conformance, made checkable. Every other invariant here has a gate
// because it drifted once; the v2 designs drifted for weeks with none. This
// gate holds what a rule can hold and says so: each inventory names the
// elements a design draws, the copy each one carries, and the evidence in the
// implementation that it exists. The design file's digest ties the inventory
// to the design it was read from, and every literal string the template draws
// must be claimed by an element or classed as sample data, so a design change
// nothing implements is red on the day it is vendored. What it does not hold,
// and never claims to: where an element sits, how a state looks, whether the
// behaviour behind the copy is right. That remains a human reading against
// the design; the inventory's `where` and `states` are notes for that reader.

// Literal copy the template draws: text nodes and the attributes a person
// reads or a screen reader speaks. Bindings ({{ }}) are values, not copy, and
// the script's strings are reached through the elements that name them.
export function designCopy(html) {
  const templateStart = html.indexOf("</helmet>")
  const templateEnd = html.indexOf("</x-dc>")
  const template = html.slice(templateStart === -1 ? 0 : templateStart, templateEnd === -1 ? html.length : templateEnd)
  const copy = []
  const seen = new Set()
  const push = (raw) => {
    const text = decode(raw).replace(/\s+/g, " ").trim()
    if (!text || /^[\s·•—\-|:,.()$→]+$/.test(text) || text.includes("{{")) return
    if (seen.has(text)) return
    seen.add(text)
    copy.push(text)
  }
  for (const match of template.matchAll(/\b(?:aria-label|placeholder|title)="([^"{}]+)"/g)) push(match[1])
  for (const match of template.matchAll(/>([^<>]+)</g)) push(match[1])
  return copy
}

function decode(text) {
  return text
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
}

async function readSources(root, patterns) {
  const files = []
  for (const pattern of patterns) {
    const [base, glob] = splitPattern(pattern)
    const extensions = extensionsOf(glob)
    await walk(resolve(root, base), files, extensions)
  }
  const texts = await Promise.all(files.map((file) => readFile(file, "utf8")))
  const names = files.map((file) => relative(root, file).split(sep).join("/"))
  return { files: names, text: texts.join("\n"), byFile: new Map(names.map((name, index) => [name, texts[index]])) }
}

function splitPattern(pattern) {
  const star = pattern.indexOf("*")
  const cut = pattern.lastIndexOf("/", star)
  return [pattern.slice(0, cut), pattern.slice(cut + 1)]
}

function extensionsOf(glob) {
  const braces = /\{([^}]+)\}/.exec(glob)
  const list = braces ? braces[1].split(",") : [glob.slice(glob.lastIndexOf(".") + 1)]
  return new Set(list.map((item) => `.${item.trim()}`))
}

async function walk(directory, files, extensions) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue
      await walk(path, files, extensions)
      continue
    }
    if (/\.test\.[cm]?[jt]sx?$/.test(entry.name) || /\.fixture\./.test(entry.name)) continue
    if ([...extensions].some((extension) => entry.name.endsWith(extension))) files.push(path)
  }
}

// Evidence is a string the sources must contain, "re:" plus a pattern, or
// { absent, in }: a string one named file must not contain. The last one is
// how "these controls leave the composer" becomes a rule: the design puts
// them elsewhere, and elsewhere is checked by the element that owns them.
function evidenceMatches(evidence, sources) {
  if (typeof evidence === "object" && evidence !== null) {
    const file = sources.byFile.get(evidence.in)
    if (file === undefined) return false
    return !file.includes(evidence.absent)
  }
  if (evidence.startsWith("re:")) return new RegExp(evidence.slice(3), "m").test(sources.text)
  return sources.text.includes(evidence)
}

function describe(evidence) {
  return typeof evidence === "object" && evidence !== null ? `"${evidence.absent}" absent from ${evidence.in}` : `"${evidence}"`
}

function datedReason(record, field) {
  const value = record[field]
  return value && typeof value.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.since) && typeof value.reason === "string" && value.reason.trim()
}

export async function checkConformance(root, inventoryPath) {
  const inventory = JSON.parse(await readFile(resolve(root, inventoryPath), "utf8"))
  const failures = []
  const missing = []
  const partial = []
  const blocked = []
  const built = []
  const html = await readFile(resolve(root, inventory.design), "utf8")
  const sha256 = createHash("sha256").update(html).digest("hex")
  if (sha256 !== inventory.sha256) {
    failures.push(`${inventoryPath}: design digest ${sha256.slice(0, 12)} differs from the recorded ${String(inventory.sha256).slice(0, 12)}; re-read ${inventory.design}, classify its copy, and record the new digest with today's derivedOn`)
  }
  const copy = designCopy(html)
  const drawn = new Set(copy)
  const claimed = new Map()
  const claim = (text, owner) => {
    if (!drawn.has(text)) failures.push(`${inventoryPath}: ${owner} claims stale copy "${text}" that ${inventory.design} no longer draws`)
    if (claimed.has(text) && claimed.get(text) !== owner) failures.push(`${inventoryPath}: "${text}" is claimed by both ${claimed.get(text)} and ${owner}`)
    claimed.set(text, owner)
  }
  for (const text of inventory.sample ?? []) claim(text, "sample")
  const sources = await readSources(root, inventory.sources ?? [])
  if (sources.files.length === 0) failures.push(`${inventoryPath}: sources ${JSON.stringify(inventory.sources)} matched no files`)
  const ids = new Set()
  for (const element of inventory.elements ?? []) {
    const label = `${inventoryPath} ${element.id}`
    if (!element.id || ids.has(element.id)) failures.push(`${label}: missing or repeated id`)
    ids.add(element.id)
    if (!element.name || !element.where) failures.push(`${label}: needs a name and a where`)
    for (const text of element.copy ?? []) claim(text, element.id)
    const evidence = element.evidence ?? []
    const unmet = evidence.filter((item) => !evidenceMatches(item, sources))
    if (element.blocked) {
      if (!datedReason(element, "blocked") || !["protocol", "platform", "design"].includes(element.blocked.needs)) {
        failures.push(`${label}: blocked needs since, reason and needs (protocol | platform | design)`)
      }
      blocked.push(element)
      continue
    }
    if (element.missing) {
      if (!datedReason(element, "missing")) failures.push(`${label}: missing needs since (YYYY-MM-DD) and reason`)
      if (evidence.length > 0 && unmet.length === 0) failures.push(`${label}: no longer missing, its evidence is in the sources; remove the missing entry`)
      missing.push(element)
      continue
    }
    // Partial: the element exists (its presence strings are in the sources)
    // but not as the design draws it (its evidence is not all there). Both
    // halves are checked so the entry cannot describe something that is gone
    // or something that is finished.
    if (element.partial) {
      if (!datedReason(element, "partial")) failures.push(`${label}: partial needs since (YYYY-MM-DD) and reason`)
      const presence = element.presence ?? []
      if (presence.length === 0) failures.push(`${label}: partial needs presence, the strings that prove the element exists today`)
      for (const item of presence.filter((text) => !evidenceMatches(text, sources))) failures.push(`${label}: presence ${describe(item)} not found; the element is missing, not partial`)
      if (evidence.length === 0) failures.push(`${label}: partial needs evidence, what the design draws that is not there yet`)
      if (evidence.length > 0 && unmet.length === 0) failures.push(`${label}: no longer partial, all of its evidence is in the sources; make it built`)
      partial.push(element)
      continue
    }
    if (evidence.length === 0) failures.push(`${label}: a built element needs evidence, or a dated missing or blocked entry`)
    for (const item of unmet) failures.push(`${label}: evidence ${describe(item)} not met in ${inventory.sources.join(", ")}`)
    built.push(element)
  }
  // What no rule holds: arrangement, states as drawn, behaviour. Each entry
  // names an element and is dated, so the reader knows what this gate did
  // not verify and since when.
  const humanRead = inventory.humanRead ?? []
  for (const item of humanRead) {
    if (!item.id || !ids.has(item.id)) failures.push(`${inventoryPath}: humanRead names ${item.id ?? "no element"}, which is not in elements`)
    if (!item.since || !/^\d{4}-\d{2}-\d{2}$/.test(item.since) || !item.note) failures.push(`${inventoryPath}: humanRead ${item.id} needs since and note`)
  }
  for (const text of copy) {
    if (!claimed.has(text)) failures.push(`${inventoryPath}: unclaimed copy "${text}"; add it to an element's copy or to sample with the design as the source`)
  }
  return { inventory: inventoryPath, design: inventory.design, sha256, copy: copy.length, built, partial, missing, blocked, humanRead, failures }
}

export async function checkAll(root = repositoryRoot) {
  const directory = resolve(root, inventoryDirectory)
  const entries = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort()
  const results = []
  for (const name of entries) results.push(await checkConformance(root, `${inventoryDirectory}/${name}`))
  return results
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const results = await checkAll()
  let failed = false
  for (const result of results) {
    const line = `${result.inventory}: ${result.built.length} built, ${result.partial.length} partial, ${result.missing.length} missing, ${result.blocked.length} blocked; ${result.humanRead.length} human-read notes this gate does not verify; ${result.copy} copy strings; digest ${result.sha256.slice(0, 12)}`
    console.log(line)
    for (const failure of result.failures) {
      failed = true
      console.error(`  ${failure}`)
    }
  }
  if (failed) process.exitCode = 1
  // A directory with no inventories is a gate that verifies nothing; say so.
  if (results.length === 0) {
    console.error(`${inventoryDirectory}: no inventories`)
    process.exitCode = 1
  }
  await stat(resolve(repositoryRoot, inventoryDirectory))
}
