import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

// Every daemon Git spawn names its command through gitCommand (ruling Q301):
// a bare "git" handed to execFile or spawn is looked up in the current
// directory first on Windows. Test files and test fixtures, which run only in
// the test suite, are exempt.
describe("daemon Git spawns", () => {
  it("name no bare git command", async () => {
    const directory = import.meta.dirname
    const offenders: string[] = []
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name)
        if (entry.isDirectory()) {
          await walk(child)
          continue
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name.endsWith(".fixture.ts") || entry.name.startsWith("test-")) continue
        const source = await readFile(child, "utf8")
        for (const match of source.matchAll(/\b(?:execFile|execFileSync|spawn|spawnSync|execute|exec)\(\s*["'`]git["'`]/gu)) {
          offenders.push(`${child.slice(directory.length + 1)}:${source.slice(0, match.index).split("\n").length}`)
        }
      }
    }
    await walk(directory)
    expect(offenders).toEqual([])
  })
})
