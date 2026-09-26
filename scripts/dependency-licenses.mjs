import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { pnpmInvocation } from "./package-artifact-command.mjs"
import { bootstrapDeadline } from "./bootstrap-deadline.mjs"
import { publishablePackages } from "./release-packages.mjs"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")

// The desktop app ships its own production graph, the UI graph electron-vite
// inlines into out/renderer, and the workspace packages electron-builder
// copies. pnpm licenses list does not follow workspace links, so each one is
// named. scripts/dependency-licenses.test.mjs checks this against the manifests.
export const desktopPackages = [
  "@getdomovoi/desktop",
  "@getdomovoi/ui",
  "@getdomovoi/daemon",
  "@getdomovoi/credential-store",
  "@getdomovoi/protocol",
]
export const auditedPackages = [...new Set([...publishablePackages, ...desktopPackages])]

// Electron is a development dependency of apps/desktop because electron-builder
// bundles it into every desktop build rather than installing it, so the
// production graph never lists it. Chromium's own third-party licenses ship as
// LICENSES.chromium.html; this audit reads Electron's declared license only.
export const bundledRuntimes = [{ name: "electron", workspace: "apps/desktop" }]

function exceptionMatcher(key) {
  if (!key.includes("*")) return (name) => name === key
  const source = key.split("*").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join(".*")
  const pattern = new RegExp(`^${source}$`)
  return (name) => pattern.test(name)
}

function satisfiesPolicy(license, allowed) {
  if (allowed.includes(license)) return true

  const expression = license.replace(/[()]/g, " ").trim()
  if (/\bOR\b/.test(expression) && !/\bAND\b/.test(expression)) {
    return expression.split(/\bOR\b/).some((term) => allowed.includes(term.trim()))
  }
  if (/\bAND\b/.test(expression) && !/\bOR\b/.test(expression)) {
    return expression.split(/\bAND\b/).every((term) => allowed.includes(term.trim()))
  }
  return false
}

export function evaluateDependencyLicenses(graph, policy) {
  const failures = []
  const seen = new Set()
  const exceptions = Object.keys(policy.exceptions ?? {}).map((key) => ({
    key,
    matches: exceptionMatcher(key),
  }))

  for (const [license, packages] of Object.entries(graph)) {
    for (const entry of packages) {
      seen.add(entry.name)
      if (exceptions.some((exception) => exception.matches(entry.name))) continue
      if (satisfiesPolicy(license, policy.allowed)) continue
      for (const version of entry.versions) {
        failures.push(`${entry.name}@${version}: ${license} is not an allowed license`)
      }
    }
  }

  if (seen.size === 0) {
    failures.push("pnpm licenses list returned no package, so no license was checked")
    return failures
  }

  for (const { key, matches } of exceptions) {
    if (key.includes("*")) continue
    if (![...seen].some((name) => matches(name))) {
      failures.push(`license-policy.json: ${key} is an exception but no longer in the dependency graph`)
    }
  }
  return failures
}

// Adds each bundled runtime as pnpm licenses list would describe it, so the
// policy and the notices treat it like any other shipped package.
export async function collectRuntimeLicenses(root = repositoryRoot, runtimes = bundledRuntimes) {
  const graph = {}
  for (const { name, workspace } of runtimes) {
    let path
    try {
      path = createRequire(join(root, workspace, "package.json")).resolve(`${name}/package.json`)
    } catch (error) {
      throw new Error(`${name} is not installed for ${workspace}: ${error.message}`, { cause: error })
    }
    const manifest = JSON.parse(await readFile(path, "utf8"))
    const license = typeof manifest.license === "string" ? manifest.license : "Unknown"
    graph[license] = [...(graph[license] ?? []), { name, versions: [manifest.version], paths: [dirname(path)], license }]
  }
  return graph
}

export function mergeLicenseGraphs(...graphs) {
  const merged = {}
  for (const graph of graphs) {
    for (const [license, entries] of Object.entries(graph)) {
      merged[license] ??= []
      for (const entry of entries) {
        const existing = merged[license].find((item) => item.name === entry.name)
        if (!existing) {
          merged[license].push({ ...entry, versions: [...entry.versions], paths: [...(entry.paths ?? [])] })
          continue
        }
        for (const [index, version] of entry.versions.entries()) {
          if (existing.versions.includes(version)) continue
          existing.versions.push(version)
          if (entry.paths?.[index]) existing.paths.push(entry.paths[index])
        }
      }
    }
  }
  return merged
}

export async function collectAuditGraph(root = repositoryRoot, { deadline } = {}) {
  return mergeLicenseGraphs(
    await collectDependencyLicenses(root, auditedPackages, { deadline }),
    await collectRuntimeLicenses(root),
  )
}

export async function collectDependencyLicenses(root = repositoryRoot, packages = auditedPackages, { deadline: parent } = {}) {
  const deadline = bootstrapDeadline(30_000, "Dependency license inventory exceeded 30000 ms", parent)
  try {
    const { command, args } = pnpmInvocation()
    const filters = packages.flatMap((name) => ["--filter", name])
    const { stdout: output } = await deadline.run(() => promisify(execFile)(command, [...args, ...filters, "licenses", "list", "--json", "--prod"], {
      cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, signal: deadline.signal, killSignal: "SIGKILL",
    }))

    if (output.trim() === "") {
      throw new Error(
        `pnpm reported no dependency for ${packages.join(", ")}; check that every publishable package still exists`,
      )
    }
    return JSON.parse(output)
  } finally { deadline.clear() }
}

async function readPolicy(root) {
  try {
    return JSON.parse(await readFile(join(root, "license-policy.json"), "utf8"))
  } catch (error) {
    throw new Error(`license-policy.json could not be read: ${error.message}`)
  }
}

export async function checkDependencyLicenses(root = repositoryRoot) {
  let policy
  let graph
  try {
    policy = await readPolicy(root)
    graph = await collectAuditGraph(root)
  } catch (error) {
    return { licenses: [], failures: [error.message] }
  }
  return { licenses: Object.keys(graph).sort(), failures: evaluateDependencyLicenses(graph, policy) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkDependencyLicenses()
  console.log(JSON.stringify(result, null, 2))
  if (result.failures.length > 0) process.exitCode = 1
}
