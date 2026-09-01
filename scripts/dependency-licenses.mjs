import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { pnpmInvocation } from "./package-artifact-command.mjs"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
export const publishablePackages = ["@getdomovoi/protocol", "@getdomovoi/daemon"]

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

export function collectDependencyLicenses(root = repositoryRoot, packages = publishablePackages) {
  const { command } = pnpmInvocation()
  const filters = packages.flatMap((name) => ["--filter", name])
  const output = execFileSync(command, [...filters, "licenses", "list", "--json", "--prod"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })

  if (output.trim() === "") {
    throw new Error(
      `pnpm reported no dependency for ${packages.join(", ")}; check that every publishable package still exists`,
    )
  }
  return JSON.parse(output)
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
    graph = collectDependencyLicenses(root)
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
