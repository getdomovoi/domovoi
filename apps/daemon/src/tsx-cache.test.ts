import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { expect, it } from "vitest"

import { removeScratchDirectory } from "./test-scratch.js"

const run = promisify(execFile)
const observer = fileURLToPath(new URL("../test-fixtures/tsx-cache-observer.cjs", import.meta.url))

it.each([0, 256])("loads TypeScript without indexing a cache containing %i unrelated files", async (entries) => {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-tsx-cache-"))
  try {
    const cache = join(scratch, `tsx-${process.geteuid?.() ?? userInfo().username}`)
    const report = join(scratch, "operations.txt")
    const source = join(scratch, "probe.mts")
    await mkdir(cache)
    // Real unrelated entries, not a mocked directory listing or a heap-size guess.
    for (let index = 0; index < entries; index += 1) {
      await writeFile(join(cache, `unrelated-${index}`), "{}")
    }
    await writeFile(source, 'const answer: number = 42; console.log(`DOMOVOI_TSX_OK ${answer}`)\n')
    const environment: NodeJS.ProcessEnv = {
      ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
      DOMOVOI_TEST_TSX_CACHE: cache, DOMOVOI_TEST_TSX_REPORT: report,
    }
    delete environment.TSX_DISABLE_CACHE
    const load = async () => {
      await writeFile(report, "")
      const result = await run(process.execPath, [
        "--require", observer, "--import", import.meta.resolve("tsx"), source,
      ], {
        env: environment, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
        maxBuffer: 64 * 1024, windowsHide: true,
      })
      expect(result.stdout.trim()).toBe("DOMOVOI_TSX_OK 42")
      return (await readFile(report, "utf8")).split("\n").filter(Boolean)
    }

    const cold = await load()
    expect((await readdir(cache)).length).toBeGreaterThan(entries)
    // A fresh process must read the disk cache, so an accidentally disabled cache
    // cannot pass the no-enumeration assertion. This is the installed Node loader.
    const warm = await load()
    expect(warm).toContain("cache-hit")
    expect({
      cold: cold.filter((op) => op === "enumerate").length,
      warm: warm.filter((op) => op === "enumerate").length,
    }).toEqual({ cold: 0, warm: 0 })
  } finally {
    await removeScratchDirectory(scratch)
  }
}, 40_000)
