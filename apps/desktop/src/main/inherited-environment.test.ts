import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

// The desktop main process has one entry point, src/main/index.ts, and every
// window, daemon, terminal and helper it starts inherits process.env. Its first
// import takes the inherited credentials and the development daemon token out
// of process.env, before any other module of the app runs.
const names = ["DOMOVOI_AUTH_TOKEN", "DOMOVOI_CREDENTIAL_PATH", "DOMOVOI_RELAY_CREDENTIAL_FILE", "DOMOVOI_DEV_DAEMON_TOKEN"] as const
const previous = new Map<string, string | undefined>()

afterEach(() => {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  previous.clear()
  vi.resetModules()
})

describe("desktop main entry point", () => {
  it("imports the credential capture before anything else", async () => {
    const source = await readFile(join(import.meta.dirname, "index.ts"), "utf8")
    const firstImport = source.split("\n").find((line) => line.startsWith("import "))
    expect(firstImport).toBe('import { developmentEnvironment } from "./inherited-environment.js"')
  })

  it("takes the credentials and the development daemon token out of process.env when it loads", async () => {
    for (const name of names) {
      previous.set(name, process.env[name])
      process.env[name] = name.endsWith("TOKEN") ? "d".repeat(43) : `/tmp/${name.toLowerCase()}`
    }
    vi.resetModules()
    const { developmentEnvironment } = await import("./inherited-environment.js")

    for (const name of names) expect(process.env[name], name).toBeUndefined()
    // The development seam still reads the token it was given; nothing else does.
    expect(developmentEnvironment().DOMOVOI_DEV_DAEMON_TOKEN).toBe("d".repeat(43))
    expect(developmentEnvironment().DOMOVOI_AUTH_TOKEN).toBeUndefined()
  })
})

// Owner ruling 2026-09-26 (#577, A): the daemon loads at run time from the
// runtime the app ships, so this first module takes the three values out with
// its own code, holds them, and hands them to that daemon once it loads.
describe("credentials held until the daemon loads", () => {
  const credentialNames = ["DOMOVOI_AUTH_TOKEN", "DOMOVOI_CREDENTIAL_PATH", "DOMOVOI_RELAY_CREDENTIAL_FILE"] as const

  const inherited = (name: string) => name.endsWith("TOKEN") ? "d".repeat(43) : `/tmp/${name.toLowerCase()}`

  function inherit(): void {
    for (const name of names) {
      previous.set(name, process.env[name])
      process.env[name] = inherited(name)
    }
  }

  it("imports no value from the daemon", async () => {
    const source = await readFile(join(import.meta.dirname, "inherited-environment.ts"), "utf8")
    const daemonImports = source.split("\n").filter((line) => /from\s+"@getdomovoi\/daemon"/u.test(line))
    expect(daemonImports.filter((line) => !line.startsWith("import type "))).toEqual([])
  })

  it("holds the three values and hands them over once", async () => {
    inherit()
    vi.resetModules()
    const environment = await import("./inherited-environment.js")
    for (const name of names) expect(process.env[name], name).toBeUndefined()
    const held = environment.takeInheritedCredentials()
    // Compared, never printed.
    expect(credentialNames.map((name) => held[name] === inherited(name))).toEqual([true, true, true])
    expect(Object.keys(held).sort()).toEqual([...credentialNames].sort())
    expect(environment.takeInheritedCredentials()).toEqual({})
  })

  it("leaves nothing for a child started before the hand-over to inherit", async () => {
    inherit()
    vi.resetModules()
    const environment = await import("./inherited-environment.js")
    const { spawnSync } = await import("node:child_process")
    // The child reports only whether any of the names reached it.
    const child = spawnSync(process.execPath, ["-e", `process.exit(${JSON.stringify(names)}.some((name) => name in process.env) ? 3 : 0)`], { stdio: "ignore" })
    expect(child.status).toBe(0)
    expect(Object.keys(environment.takeInheritedCredentials()).sort()).toEqual([...credentialNames].sort())
  })
})
