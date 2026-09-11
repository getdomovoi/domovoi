import { execFile } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
const allowlistFile = "scripts/tick-citations-allowlist.json"
const pruneCommand = "pnpm ticks:prune"

// A ticked box is a claim, and a claim with no evidence attached expires without
// anyone noticing. ROADMAP.md carried "Token and cost telemetry normalized per
// turn, session, provider, and model" as [x] for eight days while three of the
// four adapters it covered were wrong, because [x] says what was verified and
// never when. A plan authored outside the repository has the same shape: three
// of WORK-SPLIT.md's boxes were already done on the day it was written.
//
// So every [x] names the commits that make it checkable. The exemptions below
// are the ticks that predate this rule; the list only ever shrinks, because a
// tick that gains a citation and keeps its exemption is a second untracked
// claim rather than a tidy one.
export const citedFiles = ["ROADMAP.md", "WORK-SPLIT.md", "SHIP-PLAN.md"]

// Every bullet Markdown allows, not the two this file happened to use. A "+"
// bullet or an ordered "1." item collected no tick at all, so it passed uncited
// while looking identical to a checked one — and worse, a nested "+ [x] Child
// (sha)" was not recognised as opening a list either, so it was folded into an
// uncited parent's body and satisfied the parent's citation from the child's
// evidence. A gate that fails open is the shape this whole file exists to stop.
const tickPattern = /^(\s*)(?:[-*+]|\d+[.)])\s+\[x\]\s+(.*)$/i
const listItemPattern = /^\s*(?:[-*+]\s|\d+[.)]\s)/
// A citation lives in parentheses so it reads as evidence beside the claim
// rather than as part of it. Anything inside those parentheses may sit beside
// the sha — "(1b683d6 · session totals 76d11c2)" cites two commits and says
// which is which.
const parenthesised = /\(([^()]*)\)/g
const shaPattern = /\b[0-9a-f]{7,40}\b/g
// The pattern above carries /g, so its lastIndex advances between calls and
// `.test` would answer differently for the same input. Membership questions use
// this one instead.
const containsSha = /\b[0-9a-f]{7,40}\b/

export function normalizeTickText(text) {
  return text.replace(/\s+/g, " ").trim()
}

// An exemption has to survive the thing it is waiting for. Keying it on the raw
// tick text does not: adding "(1b683d6)" rewrites the key, so the entry reads as
// an exemption for a tick that no longer exists rather than one that has been
// satisfied, and the message tells you the wrong thing. Strip the citations out
// of the key and the same tick answers to the same name cited or not.
export function exemptionKey(text) {
  return normalizeTickText(
    text.replace(parenthesised, (group, inside) => (containsSha.test(inside) ? "" : group)),
    // Removing "(d1f974f)" from "... a collapsed `details` (d1f974f)." leaves a
    // space in front of the full stop. Collapsing runs of whitespace does not
    // close that gap, so the key would differ from the uncited one by a single
    // space and the entry would read as an exemption for a vanished tick.
  ).replace(/\s+([.,;:!?])/g, "$1")
}

// The item is the tick line plus the lines that continue it: indented deeper and
// not opening a list of their own. A nested "- [ ]" under a tick is its own
// item, not this one's evidence, so it never satisfies this one's citation.
export function collectTicks(markdown) {
  const lines = markdown.split("\n")
  const ticks = []
  for (const [index, line] of lines.entries()) {
    const match = tickPattern.exec(line)
    if (!match) continue
    const [, indent, firstLine] = match
    const body = [firstLine]
    for (const next of lines.slice(index + 1)) {
      const trimmed = next.trim()
      if (trimmed === "") break
      const nextIndent = next.length - next.trimStart().length
      if (nextIndent <= indent.length) break
      if (listItemPattern.test(next)) break
      body.push(trimmed)
    }
    ticks.push({
      line: index + 1,
      text: normalizeTickText(firstLine),
      key: exemptionKey(firstLine),
      body: body.join(" "),
    })
  }
  return ticks
}

export function citedShas(itemText) {
  const shas = []
  for (const [, inside] of itemText.matchAll(parenthesised)) {
    for (const [sha] of inside.matchAll(shaPattern)) shas.push(sha)
  }
  return shas
}

export async function readAllowlist(root = repositoryRoot) {
  try {
    return JSON.parse(await readFile(join(root, allowlistFile), "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
}

async function resolvableShas(shas, root) {
  if (shas.length === 0) return { unresolved: [], skipped: false }
  try {
    const { stdout } = await run("git", ["rev-parse", "--is-shallow-repository"], { cwd: root })
    // A shallow clone cannot answer whether a sha is an ancestor. Saying so and
    // then exiting zero is the failure this whole check exists to prevent: a
    // green run that proved nothing. Unverifiable is a failure, and the message
    // names what would make it verifiable.
    if (stdout.trim() === "true") return { unresolved: [], skipped: true }
  } catch {
    return { unresolved: [], skipped: true }
  }
  const unresolved = []
  for (const sha of shas) {
    try {
      // Reachable from HEAD, not merely present in this object store. A clone of
      // one pull request has only that branch, so a citation naming a commit
      // from another one exists here and nowhere in CI — which is how a branch
      // passed every gate locally and would have gone red on push. Existence is
      // a fact about this machine; reachability is a fact about the branch.
      await run("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: root })
    } catch {
      unresolved.push(sha)
    }
  }
  return { unresolved, skipped: false }
}

export async function checkTickCitations(root = repositoryRoot) {
  const allowlist = await readAllowlist(root)
  if (!allowlist) {
    return { ok: false, failures: [`${allowlistFile} is missing. Seed it with \`node scripts/tick-citations.mjs --seed\`.`] }
  }
  const failures = []
  let shallow = false
  for (const file of citedFiles) {
    const exempt = new Set(allowlist.exempt?.[file] ?? [])
    const stillExempt = new Set()
    let markdown
    try {
      markdown = await readFile(join(root, file), "utf8")
    } catch (error) {
      if (error.code === "ENOENT") continue
      throw error
    }
    for (const tick of collectTicks(markdown)) {
      const shas = citedShas(tick.body)
      if (shas.length === 0) {
        if (exempt.has(tick.key)) {
          stillExempt.add(tick.key)
          continue
        }
        failures.push(
          `${file}:${tick.line}: [x] with no commit citation — add \`(<sha>)\` naming what makes it checkable\n    ${tick.text}`,
        )
        continue
      }
      if (exempt.has(tick.key)) {
        // Seen, so the sweep below does not also report it as an exemption for
        // a tick that no longer exists. It exists; it graduated.
        stillExempt.add(tick.key)
        failures.push(
          `${file}:${tick.line}: cited now, still listed in ${allowlistFile}. Run \`${pruneCommand}\` to drop it.\n    ${tick.text}`,
        )
        continue
      }
      const { unresolved, skipped } = await resolvableShas(shas, root)
      shallow ||= skipped
      if (skipped) {
        failures.push(
          `${file}:${tick.line}: cannot check whether ${shas.join(", ")} is an ancestor of this branch. Fetch full history — in CI that is actions/checkout with fetch-depth: 0.`,
        )
      }
      for (const sha of unresolved) {
        failures.push(`${file}:${tick.line}: cites ${sha}, which is not an ancestor of this branch. A citation has to land in the same pull request as the commit it names.`)
      }
    }
    for (const text of exempt) {
      if (stillExempt.has(text)) continue
      failures.push(
        `${allowlistFile}: exempts a tick ${file} no longer has. Run \`${pruneCommand}\`.\n    ${text}`,
      )
    }
  }
  return { ok: failures.length === 0, failures, shallow }
}

// Pruning only ever removes. A tick that has never been cited cannot be added
// here by a command, because the exemption exists to record what predates the
// rule rather than to absorb what comes after it.
export async function pruneAllowlist(root = repositoryRoot) {
  const allowlist = await readAllowlist(root)
  if (!allowlist) throw new Error(`${allowlistFile} is missing. Seed it first.`)
  const exempt = {}
  let removed = 0
  for (const file of citedFiles) {
    const listed = allowlist.exempt?.[file] ?? []
    if (listed.length === 0) continue
    let markdown
    try {
      markdown = await readFile(join(root, file), "utf8")
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      removed += listed.length
      continue
    }
    const uncited = new Set(
      collectTicks(markdown).filter((tick) => citedShas(tick.body).length === 0).map(({ key }) => key),
    )
    const kept = listed.filter((text) => uncited.has(text))
    removed += listed.length - kept.length
    if (kept.length > 0) exempt[file] = kept
  }
  await writeAllowlist(root, { ...allowlist, exempt })
  return { removed, remaining: Object.values(exempt).reduce((total, list) => total + list.length, 0) }
}

async function writeAllowlist(root, record) {
  const ordered = {
    recordedOn: new Date().toISOString().slice(0, 10),
    note: record.note,
    exempt: record.exempt,
  }
  await writeFile(join(root, allowlistFile), `${JSON.stringify(ordered, null, 2)}\n`)
}

export async function seedAllowlist(root = repositoryRoot) {
  if (await readAllowlist(root)) {
    throw new Error(`${allowlistFile} already exists. Seeding again would re-exempt ticks the list has shed; run \`${pruneCommand}\` instead.`)
  }
  const exempt = {}
  for (const file of citedFiles) {
    let markdown
    try {
      markdown = await readFile(join(root, file), "utf8")
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      continue
    }
    const uncited = collectTicks(markdown)
      .filter((tick) => citedShas(tick.body).length === 0)
      .map(({ key }) => key)
    if (uncited.length > 0) exempt[file] = [...new Set(uncited)]
  }
  await writeAllowlist(root, {
    note: "Ticks that predate the citation rule. This list only shrinks: a tick that gains a citation is pruned, and nothing is ever added.",
    exempt,
  })
  return Object.values(exempt).reduce((total, list) => total + list.length, 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes("--seed")) {
      const count = await seedAllowlist()
      process.stdout.write(`exempted ${count} existing ticks in ${allowlistFile}\n`)
    } else if (process.argv.includes("--prune")) {
      const { removed, remaining } = await pruneAllowlist()
      process.stdout.write(`dropped ${removed} exemptions, ${remaining} remain\n`)
    } else {
      const { ok, failures, shallow } = await checkTickCitations()
      for (const failure of failures) process.stderr.write(`${failure}\n`)
      if (!ok) process.exitCode = 1

      else process.stdout.write("every [x] cites a commit that exists\n")
    }
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 1
  }
}
