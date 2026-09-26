import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { publishDependencies } from "./release-packages.mjs"

// A package publishes in a later chunk than every workspace package it needs
// at runtime. Packages with no edge between them may share a chunk.
export function evaluatePublishOrder(plan, dependencies = publishDependencies) {
  if (!Array.isArray(plan) || plan.length === 0) return ["publish plan is empty"]

  const failures = []
  const chunkByName = new Map()
  plan.forEach((chunk, index) => {
    for (const release of chunk) {
      if (release.kind !== "publish") continue
      if (!Object.hasOwn(dependencies, release.name)) {
        failures.push(`${release.name} is not a package this repository publishes`)
        continue
      }
      chunkByName.set(release.name, index)
    }
  })

  for (const [name, chunk] of chunkByName) {
    for (const dependency of dependencies[name]) {
      if (chunkByName.has(dependency) && chunkByName.get(dependency) >= chunk) {
        failures.push(`${dependency} must publish in a chunk before ${name}`)
      }
    }
  }
  return failures
}

export async function checkPublishOrder(file) {
  const document = JSON.parse(await readFile(file, "utf8"))
  const plan = document?.plan
  return {
    published: Array.isArray(plan)
      ? plan.flat().filter((release) => release.kind === "publish").map((release) => `${release.name}@${release.version}`)
      : [],
    failures: evaluatePublishOrder(plan),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2]
  if (!file) {
    console.error("usage: node scripts/publish-order.mjs <publish-plan.json>")
    process.exitCode = 2
  } else {
    const result = await checkPublishOrder(resolve(file))
    console.log(JSON.stringify(result, null, 2))
    if (result.failures.length > 0) process.exitCode = 1
  }
}
