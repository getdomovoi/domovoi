import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"

import { expect } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { waitForDaemon } from "../test-wait-for.js"
import { createServiceConfiguration, serviceConfigurationPath } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import { installService, nodeServiceEffects, type CapturedRun, type ServiceEffects, type ServicePlan } from "./install.js"

export const lifecycleBudget = 60_000
export const supervisionBudget = 90_000
export const cleanupBudget = 30_000
const productionUnit = "domovoid.service"
export function systemdManagerAvailable(options: {
  platform: NodeJS.Platform
  runtimeDirectory: string
  required: boolean
  exists?: typeof existsSync
}): boolean {
  return options.platform === "linux" && options.runtimeDirectory !== ""
    && (options.exists ?? existsSync)(join(options.runtimeDirectory, "systemd", "private"))
}

// Every systemctl this test runs passes through here. It rewrites the daemon's
// own unit name to the UUID unit this test created, refuses the system scope,
// and refuses to name any other unit, so no unit the operator owns is reachable
// even if the installer's command list changes.
export function userScoped(command: string, args: readonly string[], unit: string): string[] {
  if (command !== "systemctl") throw new Error(`This test may only run systemctl, not ${command}`)
  const scoped = args.map((argument) => (argument === productionUnit ? unit : argument))
  if (scoped[0] !== "--user") throw new Error("This test may only run systemctl in the user scope")
  const foreign = scoped.find((argument) => argument.endsWith(".service") && argument !== unit)
  if (foreign !== undefined) throw new Error(`This test may not name the unit ${foreign}`)
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
  // UUID name that cannot collide with a real one, and it is written into the
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
      if (path !== home && !path.startsWith(`${home}/`)) throw new Error(`This test may not touch ${path}`)
      return path
    }
    const effects: ServiceEffects = {
      ...base,
      write: (path, contents, active) => base.write(scopedPath(path), contents, active),
      exists: (path, active) => base.exists(scopedPath(path), active),
      remove: (path, active) => base.remove(scopedPath(path), active),
      run: (command, args, active) => base.run(command, userScoped(command, args, unit), active),
      capture: (command, args, active) => base.capture(command, userScoped(command, args, unit), active),
    }

    // Refuse rather than overwrite. Nothing is installed until the manager and
    // the filesystem both agree this name is unused.
    const before = await systemctl(["--user", "show", unit, "--property=LoadState"], deadline)
    if (before.stdout.trim() !== "LoadState=not-found") throw new Error(`${unit} already exists as ${before.stdout.trim()}`)
    if (existsSync(unitPath) || existsSync(wantsPath)) throw new Error(`${unit} already has files on disk`)

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
      install: (active) => withinServiceDeadline(active, () => installService({
        platform: "linux",
        execPath: script,
        runtime: process.execPath,
        home,
        configuration: createServiceConfiguration({}, { homeDirectory: home, platform: "linux", workingDirectory: home }),
      }, effects)),
      observed: (observed) => { pid = observed },
    }, deadline)
  } finally {
    deadline.clear()
    const cleanup = OperationDeadline.start(cleanupBudget)
    try {
      // Cleanup runs whatever the assertions did, and never depends on the
      // removal under test having worked. A deliberately broken remover may
      // have left a live process: ask the fixture to exit through its own
      // private path, never kill by a PID which might have been reused.
      const ready = readyPath
      if (ready !== undefined && existsSync(ready)) {
        await withinServiceDeadline(cleanup, () => writeFile(`${ready}.stop`, "stop"))
      }
      await systemctl(["--user", "disable", "--now", unit], cleanup)
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
      expect(left.stdout.trim()).toBe("LoadState=not-found")
      const failed = await systemctl(["--user", "list-units", "--all", "--state=failed", "--no-legend", unit], cleanup)
      expect(failed.stdout.trim()).toBe("")
      const created = installedHome
      if (created !== undefined) await withinServiceDeadline(cleanup, () => rm(created, { recursive: true, force: true }))
    } finally { cleanup.clear() }
  }
}
