import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { acquireLocalDaemon } from "./local-daemon.js"
import { createProductionDaemon, createProductionDaemonWithDependencies, productionDaemonDependencies } from "./production-daemon.js"
import { removeScratchDirectories } from "./test-scratch.js"

// Every way into the daemon takes the inherited credentials out of process.env
// as its first step, before it reads a single option. The options here throw
// on every property read, so any entry point that reads one first leaves the
// credentials behind for every child and later profile.
const credentialNames = ["DOMOVOI_AUTH_TOKEN", "DOMOVOI_CREDENTIAL_PATH", "DOMOVOI_RELAY_CREDENTIAL_FILE"] as const

const hostileOptions = () => new Proxy({}, {
  get: () => { throw new Error("an option was read before capture") },
  has: () => { throw new Error("an option was read before capture") },
  ownKeys: () => { throw new Error("an option was read before capture") },
}) as never

const entryPoints: Array<[string, () => Promise<unknown>]> = [
  ["acquireLocalDaemon", () => acquireLocalDaemon(hostileOptions())],
  ["createProductionDaemon", () => createProductionDaemon(hostileOptions())],
  ["createProductionDaemonWithDependencies", () => createProductionDaemonWithDependencies(hostileOptions(), productionDaemonDependencies)],
]

const scratch: string[] = []
const previous = new Map<string, string | undefined>()

afterEach(async () => {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  previous.clear()
  await removeScratchDirectories(scratch)
})

describe("credential capture at every daemon entry point", () => {
  it.each(entryPoints)("%s takes the inherited credentials out before reading any option", async (_name, enter) => {
    const home = await mkdtemp(join(tmpdir(), "domovoi-capture-"))
    scratch.push(home)
    for (const name of credentialNames) {
      previous.set(name, process.env[name])
      process.env[name] = name === "DOMOVOI_AUTH_TOKEN" ? "c".repeat(43) : join(home, name.toLowerCase())
    }

    await enter().catch(() => undefined)

    for (const name of credentialNames) expect(process.env[name], name).toBeUndefined()
  })
})
