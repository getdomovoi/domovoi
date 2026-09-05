import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, posix } from "node:path"

import { expect, it } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { waitForDaemon } from "../test-wait-for.js"
import { createServiceConfiguration, serviceConfigurationPath } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import { installService, nodeServiceEffects, removeService, serviceStatus, type ServiceEffects } from "./install.js"

const lifecycleBudget = 60_000
const cleanupBudget = 30_000
const productionUnit = "domovoid.service"
const runtimeDirectory = process.env.XDG_RUNTIME_DIR ?? ""
const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
// The gate is the systemd user manager's own private socket, which exists only
// while systemd --user runs for this account. A machine without one skips.
// The Linux CI leg asserts this same socket before running the suite, so a
// runner that lost its user manager fails there rather than skipping silently.
const managerRunning = process.platform === "linux" && runtimeDirectory !== ""
  && existsSync(join(runtimeDirectory, "systemd", "private"))

// Every systemctl this test runs passes through here. It rewrites the daemon's
// own unit name to the UUID unit this test created, refuses the system scope,
// and refuses to name any other unit, so no unit the operator owns is reachable
// even if the installer's command list changes.
function userScoped(command: string, args: readonly string[], unit: string): string[] {
  if (command !== "systemctl") throw new Error(`This test may only run systemctl, not ${command}`)
  const scoped = args.map((argument) => (argument === productionUnit ? unit : argument))
  if (scoped[0] !== "--user") throw new Error("This test may only run systemctl in the user scope")
  const foreign = scoped.find((argument) => argument.endsWith(".service") && argument !== unit)
  if (foreign !== undefined) throw new Error(`This test may not name the unit ${foreign}`)
  return scoped
}

it.runIf(managerRunning)("installs, reports and removes a real systemd user unit", async () => {
  // This is the native boundary, not an interception of systemd. The unit is a
  // UUID name that cannot collide with a real one, and it is written into the
  // per-boot runtime unit directory so nothing this test creates outlives a
  // reboot. The install is the daemon's own enable --now, whose persistent
  // wants symlink the removal path and the cleanup below both delete.
  const unit = `domovoi-native-test-${randomUUID()}.service`
  const unitPath = join(runtimeDirectory, "systemd", "user", unit)
  const wantsPath = join(configHome, "systemd", "user", "default.target.wants", unit)
  const deadline = OperationDeadline.start(lifecycleBudget)
  const base = nodeServiceEffects()
  const systemctl = (args: readonly string[], active: OperationDeadline) =>
    withinServiceDeadline(active, () => base.capture("systemctl", userScoped("systemctl", args, unit), active))
  let home: string | undefined
  let readyPath: string | undefined
  let pid: number | undefined
  try {
    home = await withinServiceDeadline(deadline, () => mkdtemp(join(tmpdir(), "domovoi-systemd-")))
    const productionUnitPath = posix.join(home, ".config", "systemd", "user", productionUnit)
    const configurationPath = serviceConfigurationPath(home, "linux")
    readyPath = join(posix.dirname(configurationPath), "ready")
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
    const configuration = createServiceConfiguration({}, { homeDirectory: home, platform: "linux", workingDirectory: home })
    const plan = await withinServiceDeadline(deadline, () => installService({
      platform: "linux",
      execPath: script,
      runtime: process.execPath,
      home,
      configuration,
    }, effects))
    expect(plan).toMatchObject({ kind: "file", path: productionUnitPath })

    // The manager, not the generated string, is the witness: it loaded this
    // file, enabled it, and started the process the unit names.
    const loaded = await systemctl(["--user", "show", unit, "--property=FragmentPath", "--property=UnitFileState", "--property=ActiveState"], deadline)
    expect(loaded.stdout).toContain(`FragmentPath=${unitPath}`)
    expect(loaded.stdout).toContain("UnitFileState=enabled")
    expect(loaded.stdout).toContain("ActiveState=active")
    await withinServiceDeadline(deadline, () => waitForDaemon(async () => {
      deadline.throwIfExpired()
      pid = Number(await readFile(readyPath!, "utf8"))
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
      expect(() => process.kill(pid!, 0)).not.toThrow()
    }))

    const status = await withinServiceDeadline(deadline, () => serviceStatus({ platform: "linux", home }, effects))
    expect(status).toMatchObject({ installed: true, running: true })
    expect(status.detail).toBe(`${productionUnitPath} is active`)

    const removal = await withinServiceDeadline(deadline, () => removeService({ platform: "linux", home }, effects))
    expect(removal).toMatchObject({ kind: "file", path: productionUnitPath })
    await withinServiceDeadline(deadline, () => waitForDaemon(() => {
      deadline.throwIfExpired()
      expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    }))
    const after = await systemctl(["--user", "show", unit, "--property=LoadState", "--property=ActiveState"], deadline)
    expect(after.stdout).toContain("LoadState=not-found")
    expect(after.stdout).toContain("ActiveState=inactive")
    expect(existsSync(unitPath)).toBe(false)
    expect(existsSync(wantsPath)).toBe(false)
    expect(existsSync(configurationPath)).toBe(false)
    expect(await withinServiceDeadline(deadline, () => serviceStatus({ platform: "linux", home }, effects)))
      .toMatchObject({ installed: false, running: false })
  } finally {
    deadline.clear()
    const cleanup = OperationDeadline.start(cleanupBudget)
    try {
      // Cleanup runs whatever the assertions did, and never depends on the
      // removal under test having worked. A deliberately broken remover may
      // have left a live process: ask the fixture to exit through its own
      // private path, never kill by a PID which might have been reused.
      if (readyPath !== undefined && existsSync(readyPath)) {
        await withinServiceDeadline(cleanup, () => writeFile(`${readyPath}.stop`, "stop"))
      }
      await systemctl(["--user", "disable", "--now", unit], cleanup)
      if (pid !== undefined) await withinServiceDeadline(cleanup, () => waitForDaemon(() => {
        cleanup.throwIfExpired()
        expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
      }))
      await withinServiceDeadline(cleanup, () => rm(unitPath, { force: true }))
      await withinServiceDeadline(cleanup, () => rm(wantsPath, { force: true }))
      await systemctl(["--user", "daemon-reload"], cleanup)
      const left = await systemctl(["--user", "show", unit, "--property=LoadState"], cleanup)
      expect(left.stdout.trim()).toBe("LoadState=not-found")
      if (home !== undefined) await withinServiceDeadline(cleanup, () => rm(home, { recursive: true, force: true }))
    } finally { cleanup.clear() }
  }
}, lifecycleBudget + cleanupBudget + 1_000)
