import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { expect, it, vi } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { withinServiceDeadline } from "./deadline.js"
import { nodeServiceEffects, type CapturedRun } from "./install.js"
import { systemdManagerAvailable, userScoped, withThrowawayUnit } from "./systemd-unit.test-support.js"

const safetyBudget = 10_000
type Body = Parameters<typeof withThrowawayUnit>[1]

// Run the exact native harness with real private files but no native manager.
// Even its old, destructive cleanup can only remove this scenario's fixtures.
async function scenario(
  options: { collision?: "manager" | "files"; probe?: CapturedRun },
  check: (state: {
    run: (body: Body) => Promise<void>
    calls: string[][]
    paths: string[]
    loaded: () => boolean
    outsideFile: string
  }) => Promise<void>,
) {
  const deadline = OperationDeadline.start(safetyBudget)
  const root = await withinServiceDeadline(deadline, () => mkdtemp(join(tmpdir(), "domovoi-systemd-safety-")))
  const runtimeDirectory = join(root, "runtime")
  const configHome = join(root, "config")
  const base = nodeServiceEffects({ userHomeDirectory: root })
  const calls: string[][] = []
  const paths: string[] = []
  let loaded = options.collision === "manager"
  let first = true
  try {
    await check({
      calls, paths, loaded: () => loaded, outsideFile: join(root, "escaped"),
      run: (body) => withThrowawayUnit(safetyBudget, body, {
        runtimeDirectory, configHome,
        effects: {
          ...base,
          run: async (_command, args) => { calls.push(args) },
          capture: async (_command, args, active) => {
            calls.push(args)
            if (first) {
              first = false
              const unit = args[2]
              if (unit === undefined) throw new Error("missing scoped unit")
              paths.push(join(runtimeDirectory, "systemd", "user", unit), join(configHome, "systemd", "user", "default.target.wants", unit))
              if (options.collision) for (const path of paths) await base.write(path, "pre-existing unit", active)
              return options.probe ?? { code: 0, stdout: `LoadState=${loaded ? "loaded" : "not-found"}\n` }
            }
            if (args[1] === "disable") loaded = false
            return { code: 0, stdout: args[1] === "show" ? `LoadState=${loaded ? "loaded" : "not-found"}\n` : "" }
          },
        },
      }),
    })
  } finally {
    deadline.clear()
    const cleanup = OperationDeadline.start(5_000)
    try { await withinServiceDeadline(cleanup, () => rm(root, { recursive: true, force: true })) }
    finally { cleanup.clear() }
  }
}

it.each(["manager", "files"] as const)("leaves a pre-existing %s collision untouched after refusing", async (collision) => {
  await scenario({ collision }, async ({ run, calls, paths, loaded }) => {
    const body = vi.fn<Body>(async () => {})
    await expect(run(body)).rejects.toThrow(/already exists|already has files/)
    expect(body).not.toHaveBeenCalled()
    const contents = await Promise.all(paths.map((path) => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "missing"
      throw error
    })))
    expect({ calls: calls.map((args) => args[1]), loaded: loaded(), contents }, "refusal must leave the existing unit and both files intact")
      .toEqual({ calls: ["show"], loaded: collision === "manager", contents: ["pre-existing unit", "pre-existing unit"] })
  })
}, safetyBudget + 6_000)

it("treats failed probes as unknown even when stdout says not-found", async () => {
  await scenario({ probe: { code: 1, stdout: "LoadState=not-found\n", stderr: "Failed to connect to bus" } }, async ({ run, calls }) => {
    const body = vi.fn<Body>(async () => {})
    await expect(run(body)).rejects.toThrow(/Failed to connect to bus/)
    expect(body).not.toHaveBeenCalled()
    expect(calls.map((args) => args[1])).toEqual(["show"])
  })
}, safetyBudget + 6_000)

it("does not arm cleanup merely because preflight passed", async () => {
  await scenario({}, async ({ run, calls }) => {
    const failure = new Error("failed before installation")
    await expect(run(async () => { throw failure })).rejects.toBe(failure)
    expect(calls.map((args) => args[1])).toEqual(["show"])
  })
}, safetyBudget + 6_000)

it("still retires an attempted installation after the body fails", async () => {
  await scenario({}, async ({ run, calls, paths }) => {
    const failure = new Error("assertion after install")
    await expect(run(async (unit, deadline) => { await unit.install(deadline); throw failure })).rejects.toBe(failure)
    expect(calls.some((args) => args[1] === "enable")).toBe(true)
    expect(calls.some((args) => args[1] === "disable")).toBe(true)
    for (const path of paths) expect(existsSync(path)).toBe(false)
  })
}, safetyBudget + 6_000)

it("refuses a dot-dot file escape before filesystem effects", async () => {
  await scenario({}, async ({ run, outsideFile }) => {
    await run(async (unit, deadline) => {
      const escaped = `${unit.home}/${relative(unit.home, outsideFile)}`
      await expect(unit.effects.write(escaped, "escaped", deadline)).rejects.toThrow(/may not touch/)
      expect(existsSync(outsideFile)).toBe(false)
    })
  })
}, safetyBudget + 6_000)

const unit = "domovoi-native-test-00000000-0000-4000-8000-000000000000.service"
it.each([
  ["--user", "stop", "*.target"],
  ["--user", "stop", "default.target"],
  ["--user", "reset-failed"],
  ["--user", "exit"],
  ["--user", "reboot"],
  ["--user", "--system", "stop", "domovoid.service"],
  ["--user", "--machine=other", "stop", "domovoid.service"],
  ["--user", "link", "/outside/unit.socket"],
  ["--user", "daemon-reload", "--root=/outside"],
].map((args) => ({ args })))("refuses unscoped or foreign command $args", ({ args }) => {
  expect(() => userScoped("systemctl", args, unit)).toThrow()
})

it("fails rather than silently skipping a required Linux proof when its manager disappears", () => {
  expect(() => systemdManagerAvailable({ platform: "linux", runtimeDirectory: "/missing", required: true, exists: () => false })).toThrow(/systemd.*required/i)
})

it("keeps non-Linux and optional local native proofs gated", () => {
  expect(systemdManagerAvailable({ platform: "darwin", runtimeDirectory: "", required: true })).toBe(false)
  expect(systemdManagerAvailable({ platform: "linux", runtimeDirectory: "", required: false })).toBe(false)
  expect(systemdManagerAvailable({ platform: "linux", runtimeDirectory: "/present", required: true, exists: () => true })).toBe(true)
})
