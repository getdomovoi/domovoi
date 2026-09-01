import { readFile, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
const workspaceGlob = /^\s*-\s*["']?([^"'\s/]+)\/\*{1,2}["']?\s*$/

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

export function workspaceDirectories(workspaceYaml) {
  const directories = []
  let inPackages = false
  for (const line of workspaceYaml.split(/\r?\n/)) {
    if (/^packages:/.test(line)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    const match = workspaceGlob.exec(line)
    if (match) directories.push(match[1])
    else if (line.trim() !== "") break
  }
  return directories
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
  const packages = []
  for (const directory of workspaceDirectories(yaml)) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = `${directory}/${entry.name}/package.json`
      const manifest = await readManifest(join(root, path))
      if (!manifest) continue
      packages.push({ name: manifest.name, path, version: manifest.version })
    }
  }
  return packages
}

export async function checkVersionLockstep(root = repositoryRoot) {
  const packages = await collectWorkspacePackages(root)
  return { packages, failures: evaluateVersionLockstep(packages) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkVersionLockstep()
  console.log(JSON.stringify(result, null, 2))
  if (result.failures.length > 0) process.exitCode = 1
}
