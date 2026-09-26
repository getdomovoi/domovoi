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
  it("acquires its daemon only through the local ownership seam", async () => {
    const offenders: string[] = []
    for (const [file, source] of await desktopSources()) {
      if (/\bDomovoiDaemon\b/u.test(source)) offenders.push(`${file}: names the daemon constructor`)
      if (/@getdomovoi\/daemon\/internal/u.test(source)) offenders.push(`${file}: imports the internal daemon surface`)
      // The daemon is loaded at run time from the runtime the app ships
      // (daemon-module.ts), so no source imports a value from the package:
      // a static import would pull the daemon back into the archive.
      for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@getdomovoi\/daemon"/gu)) {
        const values = match[1]!
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0 && !name.startsWith("type "))
        for (const name of values) offenders.push(`${file}: imports ${name} from @getdomovoi/daemon`)
      }
      // `import { type A }` keeps an empty side-effect import under
      // verbatimModuleSyntax, which loads the whole daemon into the bundle.
      // Only `import type` is erased.
      for (const match of source.matchAll(/^import\s*\{[^}]*\}\s*from\s*"@getdomovoi\/daemon"/gmu)) {
        if (!offenders.some((offender) => offender.startsWith(file))) offenders.push(`${file}: ${match[0].slice(0, 40)}... keeps a runtime import of @getdomovoi/daemon; use import type`)
      }
      if (/^import\s+(?!type\b)[^\n{]*from\s*"@getdomovoi\/daemon"/mu.test(source)) {
        if (!offenders.some((offender) => offender.startsWith(file))) offenders.push(`${file}: imports a value from @getdomovoi/daemon`)
      }
    }
    expect(offenders).toEqual([])
  })

  // Route verification, the handoff check and the handoff fence (#576) talk to
  // an existing home owner, and the service calls install a manager-owned service; none of
  // them constructs a daemon in this process. The constructor and the internal surface stay out.
  it("loads only the ownership seam and the service calls from the daemon", async () => {
    const { daemonModuleExports } = await import("./daemon-module.js")
    expect([...daemonModuleExports].sort()).toEqual([
      "DaemonServiceRuntimeMissingError",
      "acquireLocalDaemon",
      "captureInheritedCredentials",
      "holdServiceHandoffFence",
      "installDaemonService",
      "readDaemonServiceRuntimeVersion",
      "readDaemonServiceStatus",
      "readLocalServiceHandoffRefusal",
      "removeDaemonService",
      "serviceProfileMismatch",
      "updateDaemonService",
      "verifyLocalFleetClientRoute",
    ])
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
