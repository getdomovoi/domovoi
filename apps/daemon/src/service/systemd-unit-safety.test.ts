import { existsSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { expect, it, vi } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { removeScratchDirectory } from "../test-scratch.js"
import { parseServiceConfiguration, serializeServiceConfiguration } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import { nodeServiceEffects, type CapturedRun } from "./install.js"
import { systemdConfigHome, systemdFixtureConfiguration, systemdManagerAvailable, systemdProofRequired, userScoped, withThrowawayUnit } from "./systemd-unit.test-support.js"

const safetyBudget = 10_000
type Body = Parameters<typeof withThrowawayUnit>[1]

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

it("uses host path semantics for a Windows safety fixture home", () => {
  const home = String.raw`C:\Users\runner\AppData\Local\Temp\domovoi-systemd-fixture`
  const configuration = systemdFixtureConfiguration(home, "win32")
  expect(configuration.homeDirectory).toBe(home)
  expect(configuration.credentialPath).toBe(`${home}\\.domovoi\\daemon.token`)
  expect(parseServiceConfiguration(serializeServiceConfiguration(configuration))).toEqual(configuration)
})

it.each([undefined, ""])("resolves unset config home %j without relative cleanup paths", (configured) => {
  const home = join(tmpdir(), "native-fixture-home")
  expect(systemdConfigHome(configured, home)).toBe(join(home, ".config"))
})

it("preserves a configured systemd config home", () => {
  const home = join(tmpdir(), "native-fixture-home")
  const configured = join(home, "custom-config")
  expect(systemdConfigHome(configured, home)).toBe(configured)
})

// Run the exact native harness with real private files but no native manager.
// Even its old, destructive cleanup can only remove this scenario's fixtures.
async function scenario(
  options: { collision?: "manager" | "files"; probe?: CapturedRun; failEnable?: boolean; failCleanup?: boolean; refuseCleanup?: boolean },
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
          run: async (_command, args) => {
            calls.push(args)
            if (args[1] === "enable") {
              loaded = true
              if (options.failEnable) throw new Error("reply lost after enable")
            }
          },
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
            if (args[1] === "disable") {
              if (options.failCleanup) throw new Error("manager cleanup unavailable")
              if (options.refuseCleanup) return { code: 1, stdout: "", stderr: "manager cleanup unavailable" }
              loaded = false
            }
            return { code: 0, stdout: args[1] === "show" ? `LoadState=${loaded ? "loaded" : "not-found"}\n` : "" }
          },
        },
      }),
    })
  } finally {
    deadline.clear()
    const cleanup = OperationDeadline.start(5_000)
    try { await withinServiceDeadline(cleanup, () => removeScratchDirectory(root)) }
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

it.each(["held", "recreated"] as const)("reclaims a %s native fixture home through shared cleanup", async (kind) => {
  const removal = vi.mocked(rm)
  const original = removal.getMockImplementation()
  if (original === undefined) throw new Error("The real filesystem remover must be available")
  let home: string | undefined
  let attempts = 0
  removal.mockImplementation(async (path, options) => {
    if (path !== home) return original(path, options)
    attempts += 1
    if (kind === "held" && attempts <= 2) {
      throw Object.assign(new Error(`EPERM: fixture home is held: ${home}`), { code: "EPERM" })
    }
    await original(path, options)
    if (kind === "recreated" && attempts <= 2) await mkdir(join(home, "provider"), { recursive: true })
  })
  try {
    await scenario({}, async ({ run, loaded }) => {
      await run(async (unit, deadline) => { home = unit.home; await unit.install(deadline) })
      expect(loaded()).toBe(false)
      expect(attempts, "the shared cleanup must retry held and recreated homes").toBe(3)
      await expect(stat(home!)).rejects.toMatchObject({ code: "ENOENT" })
    })
  } finally {
    removal.mockImplementation(original)
    // The red version deliberately leaves this invocation's private home.
    // Reclaim it after restoring the real remover, never an operator's unit.
    if (home !== undefined) await removeScratchDirectory(home)
  }
}, safetyBudget + 6_000)

it("arms cleanup before enable can fail after changing manager state", async () => {
  await scenario({ failEnable: true }, async ({ run, calls, paths, loaded }) => {
    await expect(run(async (unit, deadline) => { await unit.install(deadline) })).rejects.toThrow("reply lost after enable")
    expect(calls.some((args) => args[1] === "disable")).toBe(true)
    expect(loaded()).toBe(false)
    for (const path of paths) expect(existsSync(path)).toBe(false)
  })
}, safetyBudget + 6_000)

it("rechecks absence immediately before attempting installation", async () => {
  await scenario({}, async ({ run, calls, paths }) => {
    await expect(run(async (unit, deadline) => {
      await withinServiceDeadline(deadline, () => writeFile(unit.unitPath, "another owner", { signal: deadline.signal }))
      await unit.install(deadline)
    })).rejects.toThrow(/already has files/)
    expect(calls.map((args) => args[1])).toEqual(["show", "show"])
    expect(await readFile(paths[0]!, "utf8")).toBe("another owner")
  })
}, safetyBudget + 6_000)

it.each(["throws", "refuses"] as const)("names retained files and both failures when manager cleanup %s", async (kind) => {
  await scenario({ failCleanup: kind === "throws", refuseCleanup: kind === "refuses" }, async ({ run, paths, loaded }) => {
    const original = new Error("native assertion failed")
    let home: string | undefined
    try {
      const result = await run(async (unit, deadline) => {
        home = unit.home
        await unit.install(deadline)
        throw original
      }).then(() => undefined, (error: unknown) => error)
      expect(result).toBeInstanceOf(AggregateError)
      const error = result as AggregateError
      expect(error.errors[0]).toBe(original)
      expect(error.errors[1]).toMatchObject({ message: expect.stringContaining("manager cleanup unavailable") })
      expect(error.message).toContain(paths[0])
      expect(error.message).toContain(paths[1])
      expect(error.message).toContain(home)
      expect(error.message).toContain("Confirm the unit is stopped")
      expect(loaded()).toBe(true)
      expect(existsSync(paths[0]!)).toBe(true)
      expect(existsSync(home!)).toBe(true)
    } finally {
      // No real manager ran in this scenario. Reclaim only the private home
      // returned by the harness whose intentionally failed cleanup retained it.
      const cleanup = OperationDeadline.start(5_000)
      try { if (home) await withinServiceDeadline(cleanup, () => removeScratchDirectory(home!)) }
      finally { cleanup.clear() }
    }
  })
}, safetyBudget + 6_000)

it("refuses a dot-dot file escape before filesystem effects", async () => {
  await scenario({}, async ({ run, outsideFile }) => {
    await run(async (unit, deadline) => {
      const escaped = `${unit.home}/${relative(unit.home, outsideFile)}`
      await expect(withinServiceDeadline(deadline, () => unit.effects.write(escaped, "escaped", deadline))).rejects.toThrow(/may not touch/)
      expect(existsSync(outsideFile)).toBe(false)
    })
  })
}, safetyBudget + 6_000)

it("refuses symlink traversal out of the private home before writing", async () => {
  await scenario({}, async ({ run, outsideFile }) => {
    await run(async (unit, deadline) => {
      const link = join(unit.home, "outside")
      await withinServiceDeadline(deadline, () => symlink(join(outsideFile, ".."), link, "junction"))
      await expect(withinServiceDeadline(deadline, () => unit.effects.write(join(link, "escaped"), "escaped", deadline))).rejects.toThrow(/may not touch/)
      expect(existsSync(outsideFile)).toBe(false)
    })
  })
}, safetyBudget + 6_000)

it("counts a dangling unit entry as occupied rather than absence", async () => {
  await scenario({}, async ({ run, outsideFile, paths, calls }) => {
    await expect(run(async (unit, deadline) => {
      const within = <T>(operation: () => Promise<T>) => withinServiceDeadline(deadline, operation)
      await within(() => mkdir(outsideFile))
      await within(() => symlink(outsideFile, unit.unitPath, "junction"))
      await within(() => rm(outsideFile, { recursive: true }))
      expect(existsSync(unit.unitPath)).toBe(false)
      await unit.install(deadline)
    })).rejects.toThrow(/already has files/)
    expect(calls.map((args) => args[1])).toEqual(["show", "show"])
    expect((await lstat(paths[0]!)).isSymbolicLink()).toBe(true)
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

it.each(["true", "1", "TRUE", " True ", "yes"])("refuses a missing manager when CI=%s", (ci) => {
  expect(() => systemdManagerAvailable({ platform: "linux", runtimeDirectory: "/missing", required: systemdProofRequired(ci), exists: () => false })).toThrow(/systemd.*required/i)
})

it.each([undefined, "", "0", "false", " FALSE "])("keeps explicit non-CI value %s optional", (ci) => {
  expect(systemdProofRequired(ci)).toBe(false)
})

it("keeps non-Linux and optional local native proofs gated", () => {
  expect(systemdManagerAvailable({ platform: "darwin", runtimeDirectory: "", required: true })).toBe(false)
  expect(systemdManagerAvailable({ platform: "linux", runtimeDirectory: "", required: false })).toBe(false)
  expect(systemdManagerAvailable({ platform: "linux", runtimeDirectory: "/present", required: true, exists: () => true })).toBe(true)
})

it.each([
  ["--user", "daemon-reload"],
  ["--user", "enable", "--now", "domovoid.service"],
  ["--user", "disable", "--now", "domovoid.service"],
  ["--user", "show", unit, "--property=LoadState", "--property=MainPID"],
  ["--user", "kill", "--signal=SIGKILL", "--kill-whom=main", unit],
  ["--user", "reset-failed", unit],
  ["--user", "list-units", "--all", "--state=failed", "--no-legend", unit],
].map((args) => ({ args })))("keeps the scoped native operation $args", ({ args }) => {
  expect(userScoped("systemctl", args, unit)).toEqual(args.map((argument) => argument === "domovoid.service" ? unit : argument))
})
