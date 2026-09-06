import { randomUUID } from "node:crypto"
import { existsSync, lstatSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path"

import { expect } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { removeScratchDirectory } from "../test-scratch.js"
import { waitForDaemon } from "../test-wait-for.js"
import { createServiceConfiguration, serviceConfigurationPath } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import { installService, nodeServiceEffects, type CapturedRun, type ServiceEffects, type ServicePlan } from "./install.js"

export const lifecycleBudget = 60_000
export const supervisionBudget = 90_000
export const cleanupBudget = 30_000
const productionUnit = "domovoid.service"

// Broken links are occupied names too. existsSync follows them and would
// incorrectly authorize replacing a pre-existing dangling unit or wants link.
function entryAt(path: string) {
  try { return lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export function systemdProofRequired(ci: string | undefined): boolean {
  return !["", "0", "false"].includes((ci ?? "").trim().toLowerCase())
}

export function systemdManagerAvailable(options: {
  platform: NodeJS.Platform
  runtimeDirectory: string
  required: boolean
  exists?: typeof existsSync
}): boolean {
  if (options.platform !== "linux") return false
  const available = options.runtimeDirectory !== ""
    && (options.exists ?? existsSync)(join(options.runtimeDirectory, "systemd", "private"))
  // The workflow preflight is an earlier observation, not authority to skip
  // later. CI must fail here if the manager disappears before test collection.
  // A stale socket instead reaches the bounded manager probe and fails there.
  if (!available && options.required) throw new Error("The systemd user manager is required for Linux CI. Start it and set XDG_RUNTIME_DIR before running the native proofs.")
  return available
}

// Every systemctl this test runs passes through here. It rewrites the daemon's
// own unit name to the UUID unit this test created, refuses the system scope,
// and refuses to name any other unit, so no unit the operator owns is reachable
// even if the installer's command list changes.
export function userScoped(command: string, args: readonly string[], unit: string): string[] {
  if (command !== "systemctl") throw new Error(`This test may only run systemctl, not ${command}`)
  if (!/^domovoi-native-test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.service$/.test(unit)) {
    throw new Error("This test requires a UUID-scoped unit")
  }
  const scoped = args.map((argument) => (argument === productionUnit ? unit : argument))
  const exact = (...expected: string[]) => scoped.length === expected.length && scoped.every((argument, index) => argument === expected[index])
  // daemon-reload is the sole manager-wide operation needed by the shipped
  // installer. No extra flags, target units, wildcards, paths or remote scopes.
  const allowed = exact("--user", "daemon-reload")
    || ["enable", "disable"].some((verb) => exact("--user", verb, "--now", unit))
    || ["start", "stop", "reset-failed", "is-active"].some((verb) => exact("--user", verb, unit))
    || exact("--user", "kill", "--signal=SIGKILL", "--kill-whom=main", unit)
    || exact("--user", "list-units", "--all", "--state=failed", "--no-legend", unit)
    || (scoped[0] === "--user" && scoped[1] === "show" && scoped[2] === unit && scoped.length > 3
      && scoped.slice(3).every((argument) => /^--property=[A-Za-z][A-Za-z0-9]*$/.test(argument)))
  if (!allowed) throw new Error(`This test may not run systemctl ${args.join(" ")}`)
  return scoped
}

type ThrowawayUnit = {
  unit: string
  unitPath: string
  wantsPath: string
  home: string
  productionUnitPath: string
  configurationPath: string
  readyPath: string
  effects: ServiceEffects
  systemctl: (args: readonly string[], active: OperationDeadline) => Promise<CapturedRun>
  show: (properties: readonly string[], active: OperationDeadline) => Promise<Map<string, string>>
  install: (active: OperationDeadline) => Promise<ServicePlan>
  observed: (pid: number) => void
}

// One throwaway unit, one chokepoint, one preflight and one cleanup, shared by
// every native test in this file. A second copy of this machinery is a second
// chance to name the operator's own unit, so there is only ever this one.
export async function withThrowawayUnit(
  budgetMs: number,
  body: (throwaway: ThrowawayUnit, deadline: OperationDeadline) => Promise<void>,
  host: { runtimeDirectory: string; configHome: string; effects?: ServiceEffects },
): Promise<void> {
  const { runtimeDirectory, configHome } = host
  // This is the native boundary, not an interception of systemd. The unit is a
  // UUID name checked for collisions before use, and it is written into the
  // per-boot runtime unit directory so nothing this test creates outlives a
  // reboot. The install is the daemon's own enable --now, whose persistent
  // wants symlink the removal path and the cleanup below both delete.
  const unit = `domovoi-native-test-${randomUUID()}.service`
  const unitPath = join(runtimeDirectory, "systemd", "user", unit)
  const wantsPath = join(configHome, "systemd", "user", "default.target.wants", unit)
  const deadline = OperationDeadline.start(budgetMs)
  const base = host.effects ?? nodeServiceEffects()
  const systemctl = (args: readonly string[], active: OperationDeadline) =>
    withinServiceDeadline(active, () => base.capture("systemctl", userScoped("systemctl", args, unit), active))
  // Properties come back one `Key=Value` per line, and a value may itself
  // contain an equals sign, so only the first one separates them.
  const show = async (properties: readonly string[], active: OperationDeadline) => {
    const shown = await systemctl(["--user", "show", unit, ...properties.map((property) => `--property=${property}`)], active)
    expect(shown.code).toBe(0)
    return new Map(shown.stdout.split("\n").filter((line) => line.includes("=")).map((line) => {
      const separator = line.indexOf("=")
      return [line.slice(0, separator), line.slice(separator + 1)] as const
    }))
  }
  let installedHome: string | undefined
  let readyPath: string | undefined
  let pid: number | undefined
  let cleanupArmed = false
  const failures: unknown[] = []
  async function cleanupUnit(): Promise<void> {
    const cleanup = OperationDeadline.start(cleanupBudget)
    try {
      if (cleanupArmed) {
        // Cleanup runs whatever the assertions did, and never depends on the
        // removal under test having worked. A deliberately broken remover may
        // have left a live process: ask the fixture to exit through its own
        // private path, never kill by a PID which might have been reused.
        const ready = readyPath
        if (ready !== undefined && existsSync(ready)) {
          await withinServiceDeadline(cleanup, () => writeFile(`${ready}.stop`, "stop"))
        }
        const disabled = await systemctl(["--user", "disable", "--now", unit], cleanup)
        if (disabled.code !== 0) {
          const remaining = await systemctl(["--user", "show", unit, "--property=LoadState"], cleanup)
          if (remaining.code !== 0 || remaining.stdout.trim() !== "LoadState=not-found") {
            throw new Error(`Cannot confirm ${unit} stopped: ${disabled.stderr || `systemctl exited ${disabled.code}`}`)
          }
        }
        const started = pid
        if (started !== undefined) await withinServiceDeadline(cleanup, () => waitForDaemon(() => {
          cleanup.throwIfExpired()
          expect(() => process.kill(started, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
        }))
        await withinServiceDeadline(cleanup, () => rm(unitPath, { force: true }))
        await withinServiceDeadline(cleanup, () => rm(wantsPath, { force: true }))
        await systemctl(["--user", "daemon-reload"], cleanup)
        // A unit whose last run ended in failure stays loaded and failed after
        // its file is deleted, so removing files is not enough to leave the
        // manager as it was found. This drops that entry. A unit that was never
        // loaded answers non-zero here and is already in the end state wanted,
        // so the listing below is the assertion, not this command's code.
        await systemctl(["--user", "reset-failed", unit], cleanup)
        const left = await systemctl(["--user", "show", unit, "--property=LoadState"], cleanup)
        expect(left.code, left.stderr).toBe(0)
        expect(left.stdout.trim()).toBe("LoadState=not-found")
        const failed = await systemctl(["--user", "list-units", "--all", "--state=failed", "--no-legend", unit], cleanup)
        expect(failed.code, failed.stderr).toBe(0)
        expect(failed.stdout.trim()).toBe("")
      }
      const created = installedHome
      // Keep main's independent retry and absence proof after authorization.
      // A spent manager deadline must not abandon an otherwise removable home.
      if (created !== undefined) await removeScratchDirectory(created)
    } catch (error) {
      // Unconditional deletion here would leave a possibly restartable job
      // pointing at removed files. Retain on uncertainty and preserve both the
      // original failure and cleanup evidence, with exact recovery targets.
      const retained = cleanupArmed
        ? `${unitPath}, ${wantsPath}, ${installedHome}. Confirm the unit is stopped before removing retained files.`
        : `${installedHome ?? "no known private home"}. No manager cleanup was authorized.`
      throw new AggregateError([...failures, error], `Native systemd cleanup for ${unit} did not complete. Inspect ${retained}`, { cause: error })
    } finally { cleanup.clear() }
  }

  try {
    const home = await withinServiceDeadline(deadline, () => mkdtemp(join(tmpdir(), "domovoi-systemd-")))
    installedHome = home
    const productionUnitPath = posix.join(home, ".config", "systemd", "user", productionUnit)
    const configurationPath = serviceConfigurationPath(home, "linux")
    const ready = join(posix.dirname(configurationPath), "ready")
    readyPath = ready
    // The unit is the only file that leaves the throwaway home, and it may only
    // land on the UUID path this test preflighted.
    const scopedPath = (path: string) => {
      if (path === productionUnitPath) return unitPath
      const resolved = resolve(path)
      const child = relative(home, resolved)
      if (!isAbsolute(path) || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error(`This test may not touch ${path}`)
      let parent = home
      for (const component of child.split(sep)) {
        parent = join(parent, component)
        const entry = entryAt(parent)
        if (entry === undefined) break
        if (entry.isSymbolicLink()) throw new Error(`This test may not touch ${path} through symlink ${parent}`)
      }
      return resolved
    }
    const effects: ServiceEffects = {
      ...base,
      claimServiceOperation: host.effects?.claimServiceOperation ?? nodeServiceEffects({ userHomeDirectory: home }).claimServiceOperation,
      write: (path, contents, active) => base.write(scopedPath(path), contents, active),
      exists: (path, active) => base.exists(scopedPath(path), active),
      remove: (path, active) => base.remove(scopedPath(path), active),
      run: (command, args, active) => base.run(command, userScoped(command, args, unit), active),
      capture: (command, args, active) => base.capture(command, userScoped(command, args, unit), active),
    }

    // Refuse rather than overwrite. Nothing is installed until the manager and
    // the filesystem both agree this name is unused.
    const requireAbsence = async (active: OperationDeadline) => {
      const before = await systemctl(["--user", "show", unit, "--property=LoadState"], active)
      if (before.code !== 0) throw new Error(`Cannot confirm absence of ${unit}: ${before.stderr || `systemctl exited ${before.code}`}`)
      if (before.stdout.trim() !== "LoadState=not-found") throw new Error(`${unit} already exists or its state is unknown: ${before.stdout.trim()}`)
      if (entryAt(unitPath) !== undefined || entryAt(wantsPath) !== undefined) throw new Error(`${unit} already has files on disk`)
    }
    await requireAbsence(deadline)

    const script = join(home, "unit.mjs")
    await withinServiceDeadline(deadline, () => copyFile(new URL("../../test-fixtures/systemd-unit.mjs", import.meta.url), script))
    await withinServiceDeadline(deadline, () => mkdir(join(runtimeDirectory, "systemd", "user"), { recursive: true }))

    await body({
      unit,
      unitPath,
      wantsPath,
      home,
      productionUnitPath,
      configurationPath,
      readyPath: ready,
      effects,
      systemctl,
      show,
      install: (active) => withinServiceDeadline(active, async () => {
        // Recheck at the operation, not just before copying the fixture. Once
        // installation starts it can fail after publishing or enabling, so arm
        // before invoking it, never after its reply. A refusal arms nothing.
        await requireAbsence(active)
        active.throwIfExpired()
        cleanupArmed = true
        return installService({
          platform: "linux",
          execPath: script,
          runtime: process.execPath,
          home,
          configuration: createServiceConfiguration({}, { homeDirectory: home, platform: "linux", workingDirectory: home }),
        }, effects)
      }),
      observed: (observed) => { pid = observed },
    }, deadline)
  } catch (error) {
    failures.push(error)
    throw error
  } finally {
    deadline.clear()
    await cleanupUnit()
  }
}
