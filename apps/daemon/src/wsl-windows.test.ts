import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { beforeAll, describe, expect, it } from "vitest"

import { discoverWslMachines } from "./wsl-discovery.js"
import type { WslDistribution } from "./wsl-distributions.js"
import { readDistroEndpoint } from "./wsl-endpoint.js"
import { distroGitCommand } from "./wsl-git.js"
import { listWslDistributions } from "./wsl-list.js"
import { distributionPath } from "./wsl-path.js"
import { runWslText, WslError } from "./wsl-run.js"

// Normal developer/CI runs remain optional. The dedicated WSL job names the
// distro it just booted, making missing virtualization, an empty discovery or
// an unexpected WSL 1 guest an error rather than six green skips.
const requiredDistribution = process.env["DOMOVOI_WSL_REQUIRED_DISTRIBUTION"]
const expectedMountRoot = process.env["DOMOVOI_WSL_EXPECTED_MOUNT_ROOT"]

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

// A Windows machine without WSL, such as a CI runner, answers with a
// classified refusal rather than a listing. Either is an answer; a hang, a
// crash, or an unclassified error is not.
async function listedOrRefused(): Promise<WslDistribution[]> {
  try {
    return await listWslDistributions({ timeoutMs: 20_000 })
  } catch (error) {
    if (requiredDistribution !== undefined) throw error
    expect(error).toBeInstanceOf(WslError)
    expect((error as WslError).kind).not.toBe("timed-out")
    expect((error as WslError).message).toMatch(/wsl\.exe|WSL/)
    return []
  }
}

describe.skipIf(requiredDistribution === undefined && skipReason !== undefined)(
  `the real wsl.exe${requiredDistribution !== undefined ? ` (required: ${requiredDistribution})` : skipReason ? ` (skipped: ${skipReason})` : ""}`,
  () => {
    beforeAll(async () => {
      if (requiredDistribution === undefined) return
      expect(skipReason, "Required WSL proofs need Windows with wsl.exe and nested virtualization").toBeUndefined()
      const required = (await listWslDistributions({ timeoutMs: 20_000 }))
        .find((distribution) => distribution.name === requiredDistribution)
      expect(required, "The provisioned WSL 2 distro must be present and running; no skip or WSL 1 fallback")
        .toMatchObject({ name: requiredDistribution, state: "Running", version: 2 })
    }, 30_000)

    it("lists the installed distributions, or says why it cannot, within its deadline", async () => {
      const distributions = await listedOrRefused()
      for (const distribution of distributions) {
        expect(distribution.name).not.toBe("")
        expect(["Running", "Stopped"]).toContain(distribution.state)
        expect([1, 2]).toContain(distribution.version)
      }
    }, 30_000)

    it("discovers each distribution as a machine fact without a credential in it", async () => {
      const listed = await listedOrRefused()
      const facts = await discoverWslMachines().catch((error: unknown) => {
        if (requiredDistribution !== undefined) throw error
        expect(error).toBeInstanceOf(WslError)
        return []
      })
      expect(facts.map((fact) => fact.distribution)).toEqual(listed.map((distribution) => distribution.name))
      if (requiredDistribution !== undefined) {
        expect(facts.find((fact) => fact.distribution === requiredDistribution))
          .toMatchObject({ version: 2, state: "running", daemon: "absent" })
      }
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
        .find((distribution) => distribution.state === "Running" && distribution.version === 2
          && (requiredDistribution === undefined || distribution.name === requiredDistribution))
      if (requiredDistribution !== undefined) expect(running, "Required WSL 2 distro went away before path proof").toBeDefined()
      if (!running) return skip("no running WSL 2 distribution on this machine")

      await expect(distributionPath({
        distribution: running.name,
        path: `\\\\wsl$\\${running.name}\\tmp`,
        timeoutMs: 20_000,
      })).resolves.toBe("/tmp")
    }, 60_000)

    it("refuses the Windows system drive through a running WSL 2 distribution", async ({ skip }) => {
      const running = (await listWslDistributions({ timeoutMs: 20_000 }))
        .find((distribution) => distribution.state === "Running" && distribution.version === 2
          && (requiredDistribution === undefined || distribution.name === requiredDistribution))
      if (requiredDistribution !== undefined) expect(running, "Required WSL 2 distro went away before drive proof").toBeDefined()
      if (!running) return skip("no running WSL 2 distribution on this machine")

      const systemDrive = process.env["SystemDrive"] ?? "C:"
      if (expectedMountRoot !== undefined) {
        const mounted = (await runWslText("wsl.exe", ["-d", running.name, "--", "wslpath", "-u", `${systemDrive}\\`], { timeoutMs: 20_000 })).trim()
        expect(mounted.replace(/\/+$/, "")).toBe(`${expectedMountRoot}${systemDrive[0]?.toLowerCase()}`)
        await expect(distroGitCommand({ distribution: running.name, repositoryPath: mounted, args: ["status"], timeoutMs: 20_000 }))
          .rejects.toThrow(/Windows drive/)
      }
      await expect(distributionPath({
        distribution: running.name,
        path: `${systemDrive}\\`,
        timeoutMs: 20_000,
      })).rejects.toThrow(/Windows drive/)
    }, 60_000)
  },
)
