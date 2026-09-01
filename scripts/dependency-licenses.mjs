import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { pnpmInvocation } from "./package-artifact-command.mjs"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
const publishablePackages = ["@getdomovoi/protocol", "@getdomovoi/daemon"]

function exceptionMatcher(key) {
  if (!key.includes("*")) return (name) => name === key
  const source = key.split("*").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join(".*")
  const pattern = new RegExp(`^${source}$`)
  return (name) => pattern.test(name)
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
      if (policy.allowed.includes(license)) continue
      for (const version of entry.versions) {
        failures.push(`${entry.name}@${version}: ${license} is not an allowed license`)
      }
    }
  }

  for (const { key, matches } of exceptions) {
    if (key.includes("*")) continue
    if (![...seen].some((name) => matches(name))) {
      failures.push(`license-policy.json: ${key} is an exception but no longer in the dependency graph`)
    }
  }
  return failures
}

export function collectDependencyLicenses(root = repositoryRoot) {
  const { command } = pnpmInvocation()
  const filters = publishablePackages.flatMap((name) => ["--filter", name])
  const output = execFileSync(command, [...filters, "licenses", "list", "--json", "--prod"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  return JSON.parse(output)
}

export async function checkDependencyLicenses(root = repositoryRoot) {
  const policy = JSON.parse(await readFile(join(root, "license-policy.json"), "utf8"))
  const graph = collectDependencyLicenses(root)
  return { licenses: Object.keys(graph).sort(), failures: evaluateDependencyLicenses(graph, policy) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkDependencyLicenses()
  console.log(JSON.stringify(result, null, 2))
  if (result.failures.length > 0) process.exitCode = 1
}
