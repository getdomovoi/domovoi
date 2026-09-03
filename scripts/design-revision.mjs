import { createHash } from "node:crypto"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
const designDirectory = "design"
const revisionFile = join(designDirectory, "REVISIONS.json")
const regenerateCommand = "pnpm design:revision"

// The handoff under design/ is a signed source this repository does not author.
// Recording a digest per file makes two things visible that a reader cannot
// otherwise tell apart: a local edit to a signed file, and a genuinely new
// revision published by Claude Design.
export async function designFiles(root = repositoryRoot) {
  const found = []
  async function walk(directory) {
    const entries = await readdir(join(root, directory), { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const posixPath = path.split(sep).join("/")
      if (entry.isDirectory()) await walk(path)
      // The record itself is not part of the handoff it describes.
      else if (entry.isFile() && posixPath !== revisionFile.split(sep).join("/")) found.push(posixPath)
    }
  }
  await walk(designDirectory)
  // Sorted by code unit so the record reads the same on every platform.
  return found.sort()
}

export async function designDigests(root = repositoryRoot) {
  const files = await designFiles(root)
  const digests = {}
  for (const file of files) {
    const bytes = await readFile(join(root, file))
    digests[file] = {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
  }
  return digests
}

export function compareDigests(recorded, current) {
  const changed = []
  const added = []
  const removed = []
  for (const [file, digest] of Object.entries(current)) {
    const previous = recorded[file]
    if (!previous) added.push(file)
    else if (previous.sha256 !== digest.sha256) changed.push(file)
  }
  for (const file of Object.keys(recorded)) {
    if (!current[file]) removed.push(file)
  }
  return { changed, added, removed }
}

export async function readRevisions(root = repositoryRoot) {
  try {
    return JSON.parse(await readFile(join(root, revisionFile), "utf8"))
  } catch {
    return undefined
  }
}

export async function writeRevisions(root = repositoryRoot) {
  const existing = await readRevisions(root)
  const record = {
    source: existing?.source ?? {
      tool: "Claude Design",
      project: "Relay multi-device platform",
      projectId: "a3b4404e-4d0c-451e-8dd2-203116a76c06",
    },
    recordedOn: new Date().toISOString().slice(0, 10),
    files: await designDigests(root),
  }
  await writeFile(join(root, revisionFile), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

export async function checkRevisions(root = repositoryRoot) {
  const recorded = await readRevisions(root)
  if (!recorded) {
    return { ok: false, reason: `${revisionFile} is missing. Run ${regenerateCommand}.` }
  }
  const { changed, added, removed } = compareDigests(recorded.files ?? {}, await designDigests(root))
  if (changed.length === 0 && added.length === 0 && removed.length === 0) return { ok: true }
  const lines = [
    "The signed design handoff no longer matches the revision this repository recorded.",
    ...changed.map((file) => `  changed: ${file}`),
    ...added.map((file) => `  added:   ${file}`),
    ...removed.map((file) => `  removed: ${file}`),
    "",
    "A signed file is never edited here. If Claude Design published a new revision, refresh the",
    `bundle from the project and run ${regenerateCommand} in the same change.`,
  ]
  return { ok: false, reason: lines.join("\n") }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const checking = process.argv.includes("--check")
  if (checking) {
    const result = await checkRevisions()
    if (!result.ok) {
      process.stderr.write(`${result.reason}\n`)
      process.exitCode = 1
    } else {
      process.stdout.write(`design/ matches the recorded revision\n`)
    }
  } else {
    const record = await writeRevisions()
    const count = Object.keys(record.files).length
    process.stdout.write(`recorded ${count} design files in ${relative(process.cwd(), join(repositoryRoot, revisionFile))}\n`)
  }
}
