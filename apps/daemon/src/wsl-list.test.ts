import { describe, expect, it, vi } from "vitest"

import { listWslDistributions, type WslListInput } from "./wsl-list.js"

const listing = [
  "  NAME            STATE           VERSION",
  "* Ubuntu-24.04    Running         2",
  "  debian          Stopped         2",
  "",
].join("\r\n")

const noDistributions = [
  "Windows Subsystem for Linux has no installed distributions.",
  "",
  "Use 'wsl.exe --list --online' to list available distributions",
  "and 'wsl.exe --install <Distro>' to install.",
  "",
].join("\r\n")

function wslOutput(text: string): Buffer {
  return Buffer.from(`\uFEFF${text}`, "utf16le")
}

type Runner = NonNullable<WslListInput["run"]>

// wsl.exe writes what it has to say in UTF-16, like its listing, and the
// runner hands that back on the error the way execFile does.
function failing(exitCode: number | string, said: { stdout?: string; stderr?: string } = {}): Runner {
  return vi.fn<Runner>(async () => {
    throw Object.assign(new Error(`Command failed: wsl.exe --list --verbose`), {
      code: exitCode,
      stdout: wslOutput(said.stdout ?? ""),
      stderr: wslOutput(said.stderr ?? ""),
    })
  })
}

describe("listWslDistributions", () => {
  it("asks wsl.exe for the verbose listing and reads every distribution in it", async () => {
    const run = vi.fn(async () => wslOutput(listing))
    expect(await listWslDistributions({ run, platform: "win32" })).toEqual([
      { name: "Ubuntu-24.04", state: "Running", version: 2, default: true },
      { name: "debian", state: "Stopped", version: 2, default: false },
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

  it("reports no distribution when wsl.exe answers that it has none", async () => {
    const run = failing(-1, { stdout: noDistributions })
    expect(await listWslDistributions({ run, platform: "win32" })).toEqual([])
  })

  it("reads the no-distribution answer by its error code, whatever language it is in", async () => {
    const run = failing(-1, { stdout: "Es ist keine Distribution installiert.\r\nError code: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND\r\n" })
    expect(await listWslDistributions({ run, platform: "win32" })).toEqual([])
  })

  it("reports no distribution for a listing with a header and no rows", async () => {
    const run = vi.fn(async () => wslOutput("  NAME            STATE           VERSION\r\n"))
    expect(await listWslDistributions({ run, platform: "win32" })).toEqual([])
  })
})

describe("listWslDistributions when wsl.exe cannot answer", () => {
  it("says WSL is not installed rather than that there is no distribution", async () => {
    const run = vi.fn<Runner>(async () => {
      throw Object.assign(new Error("spawn wsl.exe ENOENT"), { code: "ENOENT" })
    })
    await expect(listWslDistributions({ run, platform: "win32" })).rejects.toMatchObject({ kind: "absent" })
    await expect(listWslDistributions({ run, platform: "win32" })).rejects.toThrow(/not installed/)
  })

  it("reads the optional component that is not enabled as WSL not installed", async () => {
    const run = failing(-1, { stderr: "The Windows Subsystem for Linux optional component is not enabled. Please enable it and try again.\r\nError code: Wsl/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED\r\n" })
    await expect(listWslDistributions({ run, platform: "win32" })).rejects.toMatchObject({ kind: "absent" })
  })

  it("reports a wsl.exe this session may not run as denied, not as no distribution", async () => {
    const run = vi.fn<Runner>(async () => {
      throw Object.assign(new Error("spawn wsl.exe EACCES"), { code: "EACCES" })
    })
    const refused = listWslDistributions({ run, platform: "win32" })
    await expect(refused).rejects.toMatchObject({ kind: "denied" })
    await expect(refused).rejects.toThrow(/denied/i)
    await expect(refused).rejects.not.toThrow(/no WSL distribution/)
  })

  it("reads a denial wsl.exe itself reports", async () => {
    const run = failing(-1, { stderr: "Access is denied.\r\nError code: Wsl/Service/E_ACCESSDENIED\r\n" })
    await expect(listWslDistributions({ run, platform: "win32" })).rejects.toMatchObject({ kind: "denied" })
  })

  it("reports a wsl.exe that failed as unavailable, repeating the first line it said", async () => {
    const run = failing(1, { stderr: "The Windows Subsystem for Linux instance has terminated.\r\nError code: Wsl/Service/E_FAIL\r\n" })
    const refused = listWslDistributions({ run, platform: "win32" })
    await expect(refused).rejects.toMatchObject({ kind: "unavailable" })
    await expect(refused).rejects.toThrow(/instance has terminated/)
    await expect(refused).rejects.not.toThrow(/Error code/)
  })

  it("reports an answer that is not a listing as corrupt", async () => {
    for (const answer of [Buffer.from("garbage\n", "utf8"), Buffer.alloc(0), wslOutput("Something else entirely\r\n")]) {
      const run = vi.fn<Runner>(async () => answer)
      await expect(listWslDistributions({ run, platform: "win32" })).rejects.toMatchObject({ kind: "corrupt" })
    }
  })

  it("gives up on a wsl.exe that never returns, and says it timed out", async () => {
    const run = vi.fn(async (_command: string, _args: readonly string[]) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return wslOutput(listing)
    })
    const refused = listWslDistributions({ run, platform: "win32", timeoutMs: 1 })
    await expect(refused).rejects.toMatchObject({ kind: "timed-out" })
    await expect(refused).rejects.toThrow(/did not answer/)
  })

  it("gives the child a real deadline even when asked for none", async () => {
    const run = vi.fn<Runner>(async () => wslOutput(listing))
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
