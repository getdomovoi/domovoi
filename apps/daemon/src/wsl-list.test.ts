import { describe, expect, it, vi } from "vitest"

import { listWslDistributions } from "./wsl-list.js"

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
    expect(run).toHaveBeenCalledWith("wsl.exe", ["--list", "--verbose"])
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
