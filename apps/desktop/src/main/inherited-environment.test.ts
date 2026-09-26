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
