import { describe, expect, it } from "vitest"

import { FileSharingError, replaceFile, replaceFileSync, windowsSharingBudgetMs } from "./sharing-retry.js"

const refusal = (code: unknown) => Object.assign(new Error(`${String(code)}: rename refused`), { code, syscall: "rename" })

// A clock that only the injected pause advances, and a rename that refuses
// with the given codes in turn, or with the first code forever when held.
function effects(platform: NodeJS.Platform, codes: unknown[], held = false) {
  let clock = 0
  const pauses: number[] = []
  const queue = [...codes]
  let renames = 0
  const refuseOrRename = () => {
    renames++
    const code = held ? codes[0] : queue.shift()
    if (code !== undefined) throw refusal(code)
  }
  return {
    pauses,
    renames: () => renames,
    sync: { platform, now: () => clock, pause: (ms: number) => { pauses.push(ms); clock += ms }, rename: refuseOrRename },
    async: { platform, now: () => clock, pause: async (ms: number) => { pauses.push(ms); clock += ms }, rename: async () => { refuseOrRename() } },
    advance: (ms: number) => { clock += ms },
  }
}

describe("replaceFileSync", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("retries a Windows %s refusal with a doubling pause", (code) => {
    const fixture = effects("win32", [code, code, code])
    replaceFileSync("staging", "target", fixture.sync)
    expect(fixture.pauses).toEqual([5, 10, 20])
    expect(fixture.renames()).toBe(4)
  })

  it("gives up after five seconds with an error that names the file", () => {
    const fixture = effects("win32", ["EBUSY"], true)
    let failure: unknown
    try { replaceFileSync("staging", "C:\\profile\\service.json", fixture.sync, { consequence: "Nothing was updated." }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(FileSharingError)
    expect(failure).toMatchObject({
      message: "Could not replace C:\\profile\\service.json: the file stayed held open by another process for 5 s (Windows sharing refusal EBUSY). Nothing was updated.",
      path: "C:\\profile\\service.json", code: "EBUSY", cause: { code: "EBUSY" },
    })
    expect(fixture.pauses.reduce((total, ms) => total + ms, 0)).toBe(windowsSharingBudgetMs)
    expect(Math.max(...fixture.pauses)).toBe(250)
    expect(fixture.pauses.slice(0, 7)).toEqual([5, 10, 20, 40, 80, 160, 250])
  })

  it("fails at once outside Windows or for an error that is not sharing", () => {
    for (const [platform, code] of [["linux", "EPERM"], ["darwin", "EBUSY"], ["win32", "ENOENT"], ["win32", "EXDEV"], ["win32", 1]] as const) {
      const fixture = effects(platform, [code])
      expect(() => replaceFileSync("staging", "target", fixture.sync)).toThrow(`${code}: rename refused`)
      expect(fixture.pauses).toEqual([])
      expect(fixture.renames()).toBe(1)
    }
  })

  it("stops retrying at the caller's deadline and never waits past it", () => {
    const fixture = effects("win32", ["EPERM"], true)
    let remaining = 12
    const expired = new Error("deadline expired")
    const deadline = {
      remainingMs: () => remaining,
      throwIfExpired: () => { if (remaining <= 0) throw expired },
    }
    const pause = (ms: number) => { fixture.sync.pause(ms); remaining -= ms }
    expect(() => replaceFileSync("staging", "target", { ...fixture.sync, pause }, { deadline })).toThrow(expired)
    expect(fixture.pauses).toEqual([5, 7])
    expect(fixture.renames()).toBe(2)
  })

  it("starts no rename once the caller's deadline has passed", async () => {
    const expired = new Error("deadline expired")
    const deadline = { remainingMs: () => 0, throwIfExpired: () => { throw expired } }
    const sync = effects("win32", [])
    expect(() => replaceFileSync("staging", "target", sync.sync, { deadline })).toThrow(expired)
    expect(sync.renames()).toBe(0)
    const later = effects("win32", [])
    await expect(replaceFile("staging", "target", later.async, { deadline })).rejects.toThrow(expired)
    expect(later.renames()).toBe(0)
  })

  it("uses the host's rename, pause and clock by default", () => {
    // A missing staging file fails at once on every platform: ENOENT is not sharing.
    expect(() => replaceFileSync("/nonexistent/domovoi-staging", "/nonexistent/domovoi-target")).toThrow(/ENOENT/)
  })
})

describe("replaceFile", () => {
  it("retries a Windows sharing refusal without blocking", async () => {
    const fixture = effects("win32", ["EACCES", "EPERM"])
    await replaceFile("staging", "target", fixture.async)
    expect(fixture.pauses).toEqual([5, 10])
    expect(fixture.renames()).toBe(3)
  })

  it("gives up after five seconds and fails at once elsewhere", async () => {
    const held = effects("win32", ["EPERM"], true)
    await expect(replaceFile("staging", "target", held.async)).rejects.toThrow(/Could not replace target: .*held open by another process for 5 s \(Windows sharing refusal EPERM\)\.$/)
    expect(held.pauses.reduce((total, ms) => total + ms, 0)).toBe(windowsSharingBudgetMs)
    const linux = effects("linux", ["EBUSY"])
    await expect(replaceFile("staging", "target", linux.async)).rejects.toThrow("EBUSY: rename refused")
    expect(linux.pauses).toEqual([])
  })

  it("stops retrying at the caller's deadline", async () => {
    const fixture = effects("win32", ["EBUSY"], true)
    let remaining = 8
    const expired = new Error("deadline expired")
    const deadline = { remainingMs: () => remaining, throwIfExpired: () => { if (remaining <= 0) throw expired } }
    const pause = async (ms: number) => { await fixture.async.pause(ms); remaining -= ms }
    await expect(replaceFile("staging", "target", { ...fixture.async, pause }, { deadline })).rejects.toThrow(expired)
    expect(fixture.pauses).toEqual([5, 3])
  })

  it("waits on a real timer by default", async () => {
    let refused = false
    const started = performance.now()
    await replaceFile("staging", "target", {
      platform: "win32",
      rename: () => { if (!refused) { refused = true; throw refusal("EBUSY") } },
    })
    expect(performance.now() - started).toBeGreaterThanOrEqual(4)
  })
})
