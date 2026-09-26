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
// or the data script holds must be claimed by an element or classed as sample
// data, so a design change nothing implements is red on the day it is
// vendored. Script strings not yet read are listed by name in a dated
// backlog, never waved through by count. What it does not hold,
// and never claims to: where an element sits, how a state looks, whether the
// behaviour behind the copy is right. That remains a human reading against
// the design; the inventory's `where` and `states` are notes for that reader.

// Literal copy the template draws: text nodes and the attributes a person
// reads or a screen reader speaks. Bindings ({{ }}) are values, not copy; the
// strings they draw from the data script are designScriptCopy's.
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

// Copy the design builds in its data script: menus, notices, palette commands
// and launcher chips live there and reach the template through a binding, so
// designCopy cannot see them. A literal counts when it reads as prose: it
// starts with a letter, holds a space, and is neither markup, an
// interpolation nor a style value. Single words and strings assembled at run
// time are not collected; the README says so.
export function designScriptCopy(html) {
  const marker = html.search(/<script\b[^>]*\bdata-dc-script\b/)
  if (marker === -1) return []
  const bodyStart = scriptBodyStart(html, marker)
  const bodyEnd = html.indexOf("</script>", bodyStart)
  const script = html.slice(bodyStart, bodyEnd === -1 ? html.length : bodyEnd)
  const template = new Set(designCopy(html))
  const copy = []
  const seen = new Set()
  for (const literal of scriptLiterals(script)) {
    if (literal.quote === "`" && literal.raw.includes("${")) continue
    const text = unescapeScript(literal.raw).replace(/\s+/g, " ").trim()
    if (!/^\p{L}/u.test(text) || !text.includes(" ") || /[{}<>=\\$]/.test(text) || styleValue(text)) continue
    if (template.has(text) || seen.has(text)) continue
    seen.add(text)
    copy.push(text)
  }
  return copy
}

// The opening tag carries its props as a quoted attribute that can hold ">",
// so the body starts after the tag's own closing bracket, found outside quotes.
function scriptBodyStart(html, tagStart) {
  let quote = ""
  for (let index = tagStart; index < html.length; index += 1) {
    const char = html[index]
    if (quote) {
      if (char === quote) quote = ""
    } else if (char === "\"" || char === "'") {
      quote = char
    } else if (char === ">") {
      return index + 1
    }
  }
  return html.length
}

// String literals outside comments. The data scripts hold no regular
// expression literals that contain a quote; one would be read as a string.
function scriptLiterals(script) {
  const literals = []
  let index = 0
  while (index < script.length) {
    const char = script[index]
    if (char === "/" && script[index + 1] === "/") {
      const end = script.indexOf("\n", index)
      index = end === -1 ? script.length : end
      continue
    }
    if (char === "/" && script[index + 1] === "*") {
      const end = script.indexOf("*/", index + 2)
      index = end === -1 ? script.length : end + 2
      continue
    }
    if (char !== "\"" && char !== "'" && char !== "`") {
      index += 1
      continue
    }
    let cursor = index + 1
    let closed = false
    while (cursor < script.length) {
      const next = script[cursor]
      if (next === "\\") {
        cursor += 2
        continue
      }
      if (next === char) {
        closed = true
        break
      }
      if (next === "\n" && char !== "`") break
      cursor += 1
    }
    if (closed) literals.push({ quote: char, raw: script.slice(index + 1, cursor) })
    index = cursor + 1
  }
  return literals
}

function unescapeScript(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, escape) => {
    if (escape.startsWith("u{")) return String.fromCodePoint(Number.parseInt(escape.slice(2, -1), 16))
    if (/^[ux][0-9a-fA-F]/.test(escape) && escape.length > 1) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16))
    return { n: "\n", t: "\t", r: "\r" }[escape] ?? escape
  })
}

// A style value is made of lengths, durations, colours, CSS functions and
// lowercase keywords, with at least one of the first four; a font stack ends
// in a generic family; an inline style holds a declaration ended by a
// semicolon, or is the tail of one cut by a binding. Prose has none of those
// shapes.
function styleValue(text) {
  if (/,\s*(?:monospace|sans-serif|serif|system-ui|cursive)$/.test(text)) return true
  if (/(?:^|;\s*)[a-z]+(?:-[a-z]+)*:\s*[^;]*;/.test(text) || /^(?:px|em|rem|ms|s|%)?;\s/.test(text)) return true
  const declaration = /^[a-z]+(?:-[a-z]+)*:\s+(.+)$/.exec(text)
  if (declaration && styleValue(declaration[1])) return true
  const tokens = text.split(/[\s,]+/).filter(Boolean)
  const measured = (token) => /^-?\d*\.?\d+(?:px|em|rem|%|ms|s|fr|deg|vh|vw|ch)?$/.test(token)
    || /^#[0-9a-fA-F]{3,8}$/.test(token)
    || /^[a-z-]+\(/.test(token)
  return tokens.some(measured) && tokens.every((token) => measured(token) || /^[a-z]+(?:-[a-z]+)*\)?$/.test(token) || /^[\d.)]+\)?$/.test(token))
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
  const scriptCopy = designScriptCopy(html)
  const drawn = new Set([...copy, ...scriptCopy])
  const claimed = new Map()
  const claim = (text, owner) => {
    if (!drawn.has(text)) failures.push(`${inventoryPath}: ${owner} claims stale copy "${text}" that ${inventory.design} no longer draws`)
    if (claimed.has(text) && claimed.get(text) !== owner) failures.push(`${inventoryPath}: "${text}" is claimed by both ${claimed.get(text)} and ${owner}`)
    claimed.set(text, owner)
  }
  for (const text of inventory.sample ?? []) claim(text, "sample")
  // Frame names, numbers, section eyebrows and step captions describe the
  // drawing; they are the spec's intent for a human reader, not copy the
  // product draws, and no rule holds intent.
  for (const text of inventory.annotations ?? []) claim(text, "annotations")
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
  // Script copy nobody has classified yet is listed by name and dated, so a
  // re-vendored design that adds a string still fails, a classified string
  // leaves the list, and the count is printed beside the built count.
  const backlog = inventory.scriptBacklog
  const backlogged = new Set()
  if (backlog !== undefined) {
    if (!datedReason({ scriptBacklog: backlog }, "scriptBacklog") || !Array.isArray(backlog.strings)) failures.push(`${inventoryPath}: scriptBacklog needs since (YYYY-MM-DD), reason and strings`)
    const held = new Set(scriptCopy)
    for (const text of backlog.strings ?? []) {
      if (backlogged.has(text)) failures.push(`${inventoryPath}: scriptBacklog lists "${text}" twice`)
      backlogged.add(text)
      if (!held.has(text)) failures.push(`${inventoryPath}: scriptBacklog lists "${text}", which is no longer script copy in ${inventory.design}; remove it`)
      else if (claimed.has(text)) failures.push(`${inventoryPath}: scriptBacklog lists "${text}", which ${claimed.get(text)} already claims; remove it from the backlog`)
    }
  }
  for (const text of scriptCopy) {
    if (!claimed.has(text) && !backlogged.has(text)) failures.push(`${inventoryPath}: unclaimed script copy "${text}"; the design's data script holds it, so add it to an element's copy, to sample or to annotations`)
  }
  const scriptBacklog = scriptCopy.filter((text) => backlogged.has(text) && !claimed.has(text)).length
  return { inventory: inventoryPath, design: inventory.design, sha256, copy: copy.length, scriptCopy: scriptCopy.length, scriptBacklog, built, partial, missing, blocked, humanRead, failures }
}

const v2Designs = new Map([
  ["cloud", "design/design_handoff_domovoi_v2/designs/Domovoi v2 Cloud.dc.html"],
  ["skills", "design/design_handoff_domovoi_v2/designs/Domovoi v2 Skills.dc.html"],
  ["web", "design/design_handoff_domovoi_v2/designs/Domovoi Web v2.dc.html"],
  ["tablet", "design/design_handoff_domovoi_v2/designs/Domovoi Tablet v2.dc.html"],
  ["onboarding", "design/design_handoff_domovoi_v2/designs/Domovoi v2 Onboarding.dc.html"],
  ["desktop", "design/design_handoff_domovoi_v2/designs/Domovoi Desktop V2.dc.html"],
  ["states", "design/design_handoff_domovoi_v2/designs/Domovoi v2 States.dc.html"],
  ["phone", "design/design_handoff_domovoi_v2/designs/Domovoi Phone v2.dc.html"],
  ["team", "design/design_handoff_domovoi_v2/designs/Domovoi v2 Team.dc.html"],
])

const approvedExceptions = new Set(["UX-001", "SAF-001", "SAF-002", "DEV-001", "SAF-003", "PLATFORM-001"])

async function contractSources(root, paths) {
  const files = []
  for (const path of paths) {
    if (path.includes("*")) {
      const sources = await readSources(root, [path])
      files.push(...sources.byFile)
      continue
    }
    try {
      files.push([path, await readFile(resolve(root, path), "utf8")])
    } catch {
      files.push([path, undefined])
    }
  }
  return files
}

export async function checkV2Manifest(root, manifestPath = `${inventoryDirectory}/v2-manifest.json`) {
  const manifest = JSON.parse(await readFile(resolve(root, manifestPath), "utf8"))
  const failures = []
  if (manifest.version !== 2) failures.push(`${manifestPath}: version must be 2`)
  const precedence = ["current design HTML", "approved exception ledger", "production behavior"]
  if (JSON.stringify(manifest.precedence) !== JSON.stringify(precedence)) failures.push(`${manifestPath}: precedence must be ${precedence.join(" > ")}`)
  const designs = manifest.designs ?? []
  if (designs.length !== v2Designs.size) failures.push(`${manifestPath}: requires exactly ${v2Designs.size} designs`)
  const ids = new Set()
  for (const design of designs) {
    if (!design.id || ids.has(design.id)) failures.push(`${manifestPath}: design has a missing or repeated id`)
    ids.add(design.id)
    const expected = v2Designs.get(design.id)
    if (!expected) failures.push(`${manifestPath}: ${design.id} is not a current v2 design`)
    else if (design.design !== expected) failures.push(`${manifestPath}: ${design.id} must map to ${expected}`)
    if (!design.inventory || !design.sources?.length) failures.push(`${manifestPath}: ${design.id ?? "design"} needs an inventory and implementation sources`)
    if (design.inventory) {
      try {
        const inventory = JSON.parse(await readFile(resolve(root, design.inventory), "utf8"))
        if (inventory.design !== design.design) failures.push(`${manifestPath}: ${design.id} inventory ${design.inventory} does not map to its current design`)
      } catch {
        failures.push(`${manifestPath}: ${design.id} inventory ${design.inventory} is missing`)
      }
    }
  }
  for (const id of v2Designs.keys()) if (!ids.has(id)) failures.push(`${manifestPath}: missing current v2 design ${id}`)
  const exceptionIds = new Set()
  for (const exception of manifest.exceptions ?? []) {
    if (!exception.id || exceptionIds.has(exception.id)) failures.push(`${manifestPath}: exception has a missing or repeated id`)
    exceptionIds.add(exception.id)
    if (!exception.surface || !exception.allowance || !exception.constraint) failures.push(`${manifestPath}: ${exception.id ?? "exception"} needs surface, allowance and constraint`)
  }
  for (const id of approvedExceptions) if (!exceptionIds.has(id)) failures.push(`${manifestPath}: missing approved exception ${id}`)
  for (const id of exceptionIds) if (!approvedExceptions.has(id)) failures.push(`${manifestPath}: ${id} is not an approved exception`)
  const contractIds = new Set()
  for (const contract of manifest.contracts ?? []) {
    if (!contract.id || contractIds.has(contract.id)) failures.push(`${manifestPath}: contract has a missing or repeated id`)
    contractIds.add(contract.id)
    if (!contract.sources?.length) {
      failures.push(`${manifestPath}: ${contract.id ?? "contract"} needs sources`)
      continue
    }
    const sources = await contractSources(root, contract.sources)
    for (const [path, text] of sources) {
      if (text === undefined) failures.push(`${manifestPath}: ${contract.id} source ${path} is missing`)
      for (const token of contract.forbidden ?? []) if (text?.includes(token)) failures.push(`${manifestPath}: ${contract.id} bans ${JSON.stringify(token)} in ${path}`)
    }
    const sourceText = sources.map(([, text]) => text ?? "").join("\n")
    for (const token of contract.required ?? []) if (!sourceText.includes(token)) failures.push(`${manifestPath}: ${contract.id} requires ${JSON.stringify(token)}`)
    let position = -1
    for (const token of contract.order ?? []) {
      const next = sourceText.indexOf(token, position + 1)
      if (next === -1 || next < position) {
        failures.push(`${manifestPath}: ${contract.id} requires ordered structure ${contract.order.map((item) => JSON.stringify(item)).join(" < ")}`)
        break
      }
      position = next
    }
  }
  for (const id of ["desktop-v2", "phone-v2"]) if (!contractIds.has(id)) failures.push(`${manifestPath}: missing structural contract ${id}`)
  return { inventory: manifestPath, design: "v2 manifest", sha256: "", copy: 0, scriptCopy: 0, scriptBacklog: 0, built: [], partial: [], missing: [], blocked: [], humanRead: [], failures }
}

export async function checkAll(root = repositoryRoot) {
  const directory = resolve(root, inventoryDirectory)
  const entries = (await readdir(directory)).filter((name) => name.endsWith("-v2.json")).sort()
  const results = []
  for (const name of entries) results.push(await checkConformance(root, `${inventoryDirectory}/${name}`))
  results.push(await checkV2Manifest(root))
  return results
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const results = await checkAll()
  let failed = false
  for (const result of results) {
    const line = `${result.inventory}: ${result.built.length} built, ${result.partial.length} partial, ${result.missing.length} missing, ${result.blocked.length} blocked; ${result.humanRead.length} human-read notes this gate does not verify; ${result.copy} copy strings; ${result.scriptCopy} script copy strings, ${result.scriptBacklog} of them not yet classified; digest ${result.sha256.slice(0, 12)}`
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
