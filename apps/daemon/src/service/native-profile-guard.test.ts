import { chmodSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, describe, expect, it } from "vitest"

import { nativeProfileEntryGuard } from "../../vitest.global-setup.js"
import { removeScratchDirectory } from "../test-scratch.js"

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await removeScratchDirectory(home)
})

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "domovoi-profile-guard-"))
  homes.push(home)
  return { home, profile: join(home, ".domovoi") }
}

describe("native profile metadata guard", () => {
  it("accepts an absent profile without creating it", async () => {
    const f = fixture()
    const verify = await nativeProfileEntryGuard(f.home)
    await expect(verify()).resolves.toBeUndefined()
    expect(() => statSync(f.profile)).toThrow(/ENOENT/)
  })

  it("reports a directory mtime change with identical entries", async () => {
    const f = fixture()
    mkdirSync(f.profile)
    const verify = await nativeProfileEntryGuard(f.home)
    utimesSync(f.profile, new Date(0), new Date(0))
    await expect(verify()).rejects.toThrow(/native Domovoi profile.*mtime/)
  })

  it.each(["service-operation-lease.sqlite", "profile-lease.sqlite-journal"])("reports changed mtime for %s", async (name) => {
    const f = fixture()
    mkdirSync(f.profile)
    const path = join(f.profile, name)
    writeFileSync(path, "")
    const verify = await nativeProfileEntryGuard(f.home)
    utimesSync(path, new Date(0), new Date(0))
    await expect(verify()).rejects.toThrow(/native Domovoi profile.*lease/)
  })

  it.skipIf(process.platform === "win32")("reports lease ctime changes without a file mtime change", async () => {
    const f = fixture()
    mkdirSync(f.profile)
    const path = join(f.profile, "service-operation-lease.sqlite")
    writeFileSync(path, "", { mode: 0o600 })
    const before = statSync(path, { bigint: true })
    const verify = await nativeProfileEntryGuard(f.home)
    await delay(30)
    chmodSync(path, 0o400)
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(before.mtimeNs)
    expect(statSync(path, { bigint: true }).ctimeNs).not.toBe(before.ctimeNs)
    await expect(verify()).rejects.toThrow(/native Domovoi profile.*lease/)
  })
})
