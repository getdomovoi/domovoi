import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { publishablePackages } from "./release-artifacts.mjs"

export function evaluatePublishOrder(plan, order = publishablePackages) {
  if (!Array.isArray(plan) || plan.length === 0) return ["publish plan is empty"]

  const failures = []
  const chunkByName = new Map()
  plan.forEach((chunk, index) => {
    for (const release of chunk) {
      if (release.kind !== "publish") continue
      if (!order.includes(release.name)) {
        failures.push(`${release.name} is not a package this repository publishes`)
        continue
      }
      chunkByName.set(release.name, index)
    }
  })

  const planned = order.filter((name) => chunkByName.has(name))
  for (let index = 1; index < planned.length; index += 1) {
    const before = planned[index - 1]
    const after = planned[index]
    if (chunkByName.get(before) >= chunkByName.get(after)) {
      failures.push(`${before} must publish in a chunk before ${after}`)
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
