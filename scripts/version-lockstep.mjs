import { execFile } from "node:child_process"
import { readFile, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
const packagesKey = /^packages:\s*(\[.*\])?\s*$/
const listItem = /^\s+-\s*(.+?)\s*$/
const exec = promisify(execFile)

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
  if (ranked.length > 1 && ranked[0][1] * 2 <= versioned.length) {
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

function patternToRegExp(pattern) {
  const source = pattern
    .split("/")
    .map((segment) => segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*"))
    .join("/")
  return new RegExp(`^${source}$`)
}

function isExcluded(path, exclusions) {
  return exclusions.some((pattern) => patternToRegExp(pattern).test(path) || path.startsWith(`${pattern}/`))
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
  const exclusions = []
  const unsupported = []
  for (const entry of entries.map(unquote)) {
    if (entry === "" || entry === ".") continue
    if (entry.startsWith("!")) {
      exclusions.push(entry.slice(1))
      continue
    }
    const [segment] = entry.split("/")
    if (segment.includes("*")) {
      unsupported.push(entry)
      continue
    }
    const recursive = entry.endsWith("/**") || entry.split("/").length > 2
    const known = directories.find((known) => known.directory === segment)
    if (known) known.recursive ||= recursive
    else directories.push({ directory: segment, recursive })
  }
  return { directories, exclusions, unsupported }
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

async function collectFrom(root, directory, recursive, packages, exclusions) {
  const entries = await readDirectory(join(root, directory))
  if (!entries) return false

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directoryPath = `${directory}/${entry.name}`
    if (isExcluded(directoryPath, exclusions)) continue
    const path = `${directoryPath}/package.json`
    const manifest = await readManifest(join(root, path))
    if (manifest) packages.push({ name: manifest.name, path, version: manifest.version })
    else if (recursive) await collectFrom(root, directoryPath, recursive, packages, exclusions)
  }
  return true
}

export async function collectWorkspacePackages(root = repositoryRoot) {
  const yaml = await readFile(join(root, "pnpm-workspace.yaml"), "utf8")
  const { directories, exclusions, unsupported } = workspaceDirectories(yaml)
  const failures = unsupported.map(
    (entry) => `pnpm-workspace.yaml: ${entry} names no single workspace directory`,
  )
  const packages = []

  for (const { directory, recursive } of directories) {
    const found = await collectFrom(root, directory, recursive, packages, exclusions)
    if (!found) failures.push(`pnpm-workspace.yaml: ${directory}/ is declared but missing`)
  }

  if (packages.length === 0) {
    failures.push("pnpm-workspace.yaml: no workspace package was found, so no version was checked")
  }
  return { packages, failures }
}

export async function checkVersionLockstep(root = repositoryRoot) {
  const { packages, failures } = await collectWorkspacePackages(root)
  return { packages, failures: [...failures, ...evaluateVersionLockstep(packages), ...await checkRuntimeBuildVersion(root, packages)] }
}

async function checkRuntimeBuildVersion(root, packages) {
  const protocol = packages.find((entry) => entry.name === "@getdomovoi/protocol")
  if (!protocol) return []
  const entry = `${dirname(protocol.path)}/dist/index.js`
  // Inspect the actual built export in a bounded, fresh process. Source and
  // manifest agreement alone cannot detect a stale release artifact.
  let version
  try {
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", [
      `const runtime = await import(${JSON.stringify(pathToFileURL(join(root, entry)).href)})`,
      'process.stdout.write(JSON.stringify({version: runtime.buildVersion}))',
    ].join("\n")], { timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 16_384 })
    version = JSON.parse(stdout).version
  } catch {
    return [`${entry}: runtime build identity unavailable; run pnpm --filter @getdomovoi/protocol build`]
  }
  return version === protocol.version ? [] : [
    `${entry}: buildVersion is ${String(version)}, expected ${protocol.version}; rebuild @getdomovoi/protocol`,
  ]
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkVersionLockstep()
  console.log(JSON.stringify(result, null, 2))
  if (result.failures.length > 0) process.exitCode = 1
}
