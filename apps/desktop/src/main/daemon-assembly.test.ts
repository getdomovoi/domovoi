import { readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

const desktopRoot = resolve(import.meta.dirname, "../..")

async function desktopSources(): Promise<[string, string][]> {
  const entries = await readdir(join(desktopRoot, "src"), { recursive: true })
  const files = entries
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => /\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry) && !entry.endsWith(".d.ts"))
    .map((entry) => join("src", entry))
  files.push("electron.vite.config.ts")
  return Promise.all(files.map(async (file) => [file, await readFile(join(desktopRoot, file), "utf8")] as [string, string]))
}

describe("desktop daemon assembly", () => {
  it("builds its daemon only through the production factory", async () => {
    const offenders: string[] = []
    for (const [file, source] of await desktopSources()) {
      if (/\bDomovoiDaemon\b/u.test(source)) offenders.push(`${file}: names the daemon constructor`)
      if (/@getdomovoi\/daemon\/internal/u.test(source)) offenders.push(`${file}: imports the internal daemon surface`)
      for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@getdomovoi\/daemon"/gu)) {
        const values = match[1]!
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0 && !name.startsWith("type "))
        for (const name of values) {
          if (name !== "createProductionDaemon") offenders.push(`${file}: imports ${name} from @getdomovoi/daemon`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("resolves only the published daemon entry through its tsconfig", async () => {
    const tsconfig = JSON.parse(await readFile(join(desktopRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions: { paths: Record<string, string[]> }
    }
    const daemonPaths = Object.entries(tsconfig.compilerOptions.paths)
      .filter(([alias]) => alias.startsWith("@getdomovoi/daemon"))
    expect(daemonPaths).toEqual([["@getdomovoi/daemon", ["../daemon/src/public.ts"]]])
  })
})
