import { describe, expect, it, vi } from "vitest"

import { listWslDistributions, type WslListInput } from "./wsl-list.js"

const listing = [
  "  NAME            STATE           VERSION",
  "* Ubuntu-24.04    Running         2",
  "  debian          Stopped         2",
  "",
].join("\r\n")

function wslOutput(text: string): Buffer {
  return Buffer.from(`\uFEFF${text}`, "utf16le")
}

describe("listWslDistributions", () => {
  it("asks wsl.exe for the verbose listing and reads it", async () => {
    const run = vi.fn(async () => wslOutput(listing))
    expect(await listWslDistributions({ run, platform: "win32" })).toEqual([
      { name: "Ubuntu-24.04", default: true },
    ])
    expect(run).toHaveBeenCalledWith("wsl.exe", ["--list", "--verbose"], {
      timeoutMs: expect.any(Number),
    })
  })

  it("reports no distribution where there is no WSL at all", async () => {
    const run = vi.fn(async () => wslOutput(listing))
    expect(await listWslDistributions({ run, platform: "linux" })).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })

  it("reports no distribution when wsl.exe is not installed", async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error("spawn wsl.exe ENOENT"), { code: "ENOENT" })
    })
    expect(await listWslDistributions({ run, platform: "win32" })).toEqual([])
  })

  it("reports no distribution when wsl.exe answers that it has none", async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error("no distributions"), { code: 1 })
    })
    expect(await listWslDistributions({ run, platform: "win32" })).toEqual([])
  })
})

describe("listWslDistributions when wsl.exe does not answer", () => {
  it("gives up rather than waiting on a wsl.exe that never returns", async () => {
    const run = vi.fn(async (_command: string, _args: readonly string[]) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return wslOutput(listing)
    })
    expect(await listWslDistributions({ run, platform: "win32", timeoutMs: 1 })).toEqual([])
  })

  it("gives the child a real deadline even when asked for none", async () => {
    const run = vi.fn<NonNullable<WslListInput["run"]>>(async () => wslOutput(listing))
    await listWslDistributions({ run, platform: "win32", timeoutMs: 0 })
    const options = run.mock.calls[0]?.[2] as { timeoutMs: number } | undefined
    expect(options?.timeoutMs).toBeGreaterThan(0)
  })

  it("tells the runner how long it is allowed to take", async () => {
    const run = vi.fn(async () => wslOutput(listing))
    await listWslDistributions({ run, platform: "win32", timeoutMs: 2_000 })
    expect(run).toHaveBeenCalledWith("wsl.exe", ["--list", "--verbose"], { timeoutMs: 2_000 })
  })
})
