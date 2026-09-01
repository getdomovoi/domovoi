import { readFile, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
const packagesKey = /^packages:\s*(\[.*\])?\s*$/
const listItem = /^\s+-\s*(.+?)\s*$/

function describe(packages) {
  return [...packages]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => `${entry.name} ${entry.version}`)
    .join(", ")
}

export function evaluateVersionLockstep(packages) {
  const failures = []
  const versioned = []
  for (const entry of packages) {
    if (entry.version) versioned.push(entry)
    else failures.push(`${entry.path}: ${entry.name} has no version`)
  }

  const counts = new Map()
  for (const entry of versioned) counts.set(entry.version, (counts.get(entry.version) ?? 0) + 1)
  const ranked = [...counts].sort(([, left], [, right]) => right - left)
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
    failures.push(`workspace versions disagree with no majority: ${describe(versioned)}`)
    return failures
  }

  const expected = ranked[0]?.[0]
  for (const entry of versioned) {
    if (entry.version !== expected) {
      failures.push(`${entry.path}: ${entry.name} is ${entry.version}, expected ${expected}`)
    }
  }
  return failures
}

function unquote(value) {
  return value.trim().replace(/^["']|["']$/g, "")
}

export function workspaceDirectories(workspaceYaml) {
  const entries = []
  let inPackages = false
  for (const line of workspaceYaml.split(/\r?\n/)) {
    const key = packagesKey.exec(line)
    if (key) {
      inPackages = true
      if (key[1]) entries.push(...key[1].slice(1, -1).split(","))
      continue
    }
    if (!inPackages) continue
    if (/^\S/.test(line)) {
      inPackages = false
      continue
    }
    const item = listItem.exec(line)
    if (item) entries.push(item[1])
  }

  const directories = []
  const unsupported = []
  for (const entry of entries.map(unquote)) {
    if (entry === "" || entry === "." || entry.startsWith("!")) continue
    const [segment] = entry.split("/")
    if (segment.includes("*")) unsupported.push(entry)
    else if (!directories.includes(segment)) directories.push(segment)
  }
  return { directories, unsupported }
}

async function readDirectory(path) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
}

async function readManifest(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
}

export async function collectWorkspacePackages(root = repositoryRoot) {
  const yaml = await readFile(join(root, "pnpm-workspace.yaml"), "utf8")
  const { directories, unsupported } = workspaceDirectories(yaml)
  const failures = unsupported.map(
    (entry) => `pnpm-workspace.yaml: ${entry} names no single workspace directory`,
  )
  const packages = []

  for (const directory of directories) {
    const entries = await readDirectory(join(root, directory))
    if (!entries) {
      failures.push(`pnpm-workspace.yaml: ${directory}/ is declared but missing`)
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = `${directory}/${entry.name}/package.json`
      const manifest = await readManifest(join(root, path))
      if (!manifest) continue
      packages.push({ name: manifest.name, path, version: manifest.version })
    }
  }

  if (packages.length === 0) {
    failures.push("pnpm-workspace.yaml: no workspace package was found, so no version was checked")
  }
  return { packages, failures }
}

export async function checkVersionLockstep(root = repositoryRoot) {
  const { packages, failures } = await collectWorkspacePackages(root)
  return { packages, failures: [...failures, ...evaluateVersionLockstep(packages)] }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkVersionLockstep()
  console.log(JSON.stringify(result, null, 2))
  if (result.failures.length > 0) process.exitCode = 1
}
