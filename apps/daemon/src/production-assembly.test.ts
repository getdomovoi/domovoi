import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

describe("production daemon assembly", () => {
  it("constructs the raw daemon only inside the production factory", async () => {
    const sourceRoot = import.meta.dirname
    const entries = await readdir(sourceRoot, { recursive: true })
    const offenders: string[] = []

    for (const entry of entries) {
      const normalized = entry.replaceAll("\\", "/")
      if (
        !normalized.endsWith(".ts")
        || normalized.endsWith(".test.ts")
        || normalized.endsWith(".d.ts")
        || normalized === "server.ts"
        || normalized === "production-daemon.ts"
      ) continue

      const source = await readFile(join(sourceRoot, entry), "utf8")
      if (/\bnew\s+DomovoiDaemon\b/u.test(source)) offenders.push(normalized)
    }

    expect(offenders).toEqual([])
  })
})
