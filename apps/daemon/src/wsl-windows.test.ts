import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { discoverWslMachines } from "./wsl-discovery.js"
import { readDistroEndpoint } from "./wsl-endpoint.js"
import { listWslDistributions } from "./wsl-list.js"
import { distributionPath } from "./wsl-path.js"

// These tests run the real wsl.exe, so they exist only where it does. A Linux
// or macOS runner has nothing to ask and skips them by name, and a Windows
// machine without the binary says so rather than failing.
function wslExecutable(): string | undefined {
  if (process.platform !== "win32") return undefined
  const path = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "wsl.exe")
  return existsSync(path) ? path : undefined
}

const skipReason = process.platform !== "win32"
  ? "wsl.exe exists only on Windows"
  : wslExecutable() === undefined
    ? "wsl.exe is not installed on this Windows machine"
    : undefined

// A name no machine registers, so wsl.exe has to answer that it does not exist.
const absentDistribution = `domovoi-absent-${randomBytes(6).toString("hex")}`

describe.skipIf(skipReason !== undefined)(
  `the real wsl.exe${skipReason ? ` (skipped: ${skipReason})` : ""}`,
  () => {
    it("lists the installed distributions, or none, within its deadline", async () => {
      const distributions = await listWslDistributions({ timeoutMs: 20_000 })
      for (const distribution of distributions) {
        expect(distribution.name).not.toBe("")
        expect(["Running", "Stopped"]).toContain(distribution.state)
        expect([1, 2]).toContain(distribution.version)
      }
    }, 30_000)

    it("discovers each distribution as a machine fact without a credential in it", async () => {
      const facts = await discoverWslMachines()
      const listed = await listWslDistributions({ timeoutMs: 20_000 })
      expect(facts.map((fact) => fact.distribution)).toEqual(listed.map((distribution) => distribution.name))
      for (const fact of facts) {
        expect(["present", "absent", "unknown"]).toContain(fact.daemon)
        if (fact.state === "stopped") expect(fact.daemon).toBe("absent")
        if (fact.endpoint !== undefined) expect(fact.endpoint).toMatch(/^ws:\/\/(127\.0\.0\.1|\[::1\]|localhost):\d+\/rpc$/)
      }
      expect(JSON.stringify(facts)).not.toMatch(/token/i)
    }, 60_000)

    it("does not mistake a distribution wsl.exe does not have for one with no daemon", async () => {
      await expect(readDistroEndpoint({ distribution: absentDistribution, timeoutMs: 20_000 }))
        .rejects.toThrow()
    }, 30_000)

    it("does not place a path in a distribution wsl.exe does not have", async () => {
      await expect(distributionPath({
        distribution: absentDistribution,
        path: `\\\\wsl$\\${absentDistribution}\\home`,
        timeoutMs: 20_000,
      })).rejects.toThrow(new RegExp(absentDistribution))
    }, 60_000)

    it("round-trips a path through a running WSL 2 distribution's own wslpath", async ({ skip }) => {
      const running = (await listWslDistributions({ timeoutMs: 20_000 }))
        .find((distribution) => distribution.state === "Running" && distribution.version === 2)
      if (!running) return skip("no running WSL 2 distribution on this machine")

      await expect(distributionPath({
        distribution: running.name,
        path: `\\\\wsl$\\${running.name}\\tmp`,
        timeoutMs: 20_000,
      })).resolves.toBe("/tmp")
    }, 60_000)

    it("refuses the Windows system drive through a running WSL 2 distribution", async ({ skip }) => {
      const running = (await listWslDistributions({ timeoutMs: 20_000 }))
        .find((distribution) => distribution.state === "Running" && distribution.version === 2)
      if (!running) return skip("no running WSL 2 distribution on this machine")

      const systemDrive = process.env["SystemDrive"] ?? "C:"
      await expect(distributionPath({
        distribution: running.name,
        path: `${systemDrive}\\`,
        timeoutMs: 20_000,
      })).rejects.toThrow(/Windows drive/)
    }, 60_000)
  },
)
