import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, posix } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { expect, it, vi } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { waitForDaemon } from "../test-wait-for.js"
import { createServiceConfiguration, serviceConfigurationPath } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import { installService, nodeServiceEffects, removeService, serviceStatus, type CapturedRun, type ServiceEffects, type ServicePlan } from "./install.js"
import { removeScratchDirectory } from "../test-scratch.js"

const lifecycleBudget = 60_000
const supervisionBudget = 90_000
const cleanupBudget = 30_000
const productionUnit = "domovoid.service"
const runtimeDirectory = process.env.XDG_RUNTIME_DIR ?? ""
const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
// The unit ships RestartSec=5, and the supervision test asserts the manager
// reports exactly that. A restart therefore lands five seconds after the
// process ends, which is beyond what the shared daemon wait allows, and
// proving no restart happened needs a window past that same delay.
const restartDelay = "5s"
const noRestartWindowMs = 8_000
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
async function withThrowawayUnit(
  budgetMs: number,
  body: (throwaway: ThrowawayUnit, deadline: OperationDeadline) => Promise<void>,
): Promise<void> {
  // This is the native boundary, not an interception of systemd. The unit is a
  // UUID name that cannot collide with a real one, and it is written into the
  // per-boot runtime unit directory so nothing this test creates outlives a
  // reboot. The install is the daemon's own enable --now, whose persistent
  // wants symlink the removal path and the cleanup below both delete.
  const unit = `domovoi-native-test-${randomUUID()}.service`
  const unitPath = join(runtimeDirectory, "systemd", "user", unit)
  const wantsPath = join(configHome, "systemd", "user", "default.target.wants", unit)
  const deadline = OperationDeadline.start(budgetMs)
  const base = nodeServiceEffects()
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
    await withinServiceDeadline(deadline, () => copyFile(new URL("../../test-fixtures/service-process.mjs", import.meta.url), script))
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
      // Removal stands on its own retry, so a cleanup budget the unit
      // teardown spent does not leave the home behind.
      if (created !== undefined) await removeScratchDirectory(created)
    } finally { cleanup.clear() }
  }
}

it.runIf(managerRunning)("installs, reports and removes a real systemd user unit", async () => {
  await withThrowawayUnit(lifecycleBudget, async (throwaway, deadline) => {
    const { configurationPath, effects, home, productionUnitPath, readyPath: ready, systemctl, unitPath, wantsPath } = throwaway
    const plan = await throwaway.install(deadline)
    expect(plan).toMatchObject({ kind: "file", path: productionUnitPath })

    // The manager, not the generated string, is the witness: it loaded this
    // file, enabled it, and started the process the unit names.
    const loaded = await systemctl(["--user", "show", throwaway.unit, "--property=FragmentPath", "--property=UnitFileState", "--property=ActiveState"], deadline)
    expect(loaded.stdout).toContain(`FragmentPath=${unitPath}`)
    expect(loaded.stdout).toContain("UnitFileState=enabled")
    expect(loaded.stdout).toContain("ActiveState=active")
    let pid: number | undefined
    await withinServiceDeadline(deadline, () => waitForDaemon(async () => {
      deadline.throwIfExpired()
      pid = Number(await readFile(ready, "utf8"))
      throwaway.observed(pid)
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
    const after = await systemctl(["--user", "show", throwaway.unit, "--property=LoadState", "--property=ActiveState"], deadline)
    expect(after.stdout).toContain("LoadState=not-found")
    expect(after.stdout).toContain("ActiveState=inactive")
    expect(existsSync(unitPath)).toBe(false)
    expect(existsSync(wantsPath)).toBe(false)
    expect(existsSync(configurationPath)).toBe(false)
    expect(await withinServiceDeadline(deadline, () => serviceStatus({ platform: "linux", home }, effects)))
      .toMatchObject({ installed: false, running: false })
  })
}, lifecycleBudget + cleanupBudget + 1_000)

it.runIf(managerRunning)("restarts a crashed unit and leaves a stopped one stopped", async () => {
  await withThrowawayUnit(supervisionBudget, async (throwaway, deadline) => {
    const { effects, home, readyPath: ready, show, systemctl, unit } = throwaway
    // Every wait here is bounded, and none of them may outlive the shared
    // deadline; a manager that never answers fails the test rather than
    // hanging it. Thirty seconds is six times the restart delay asserted
    // below, and the daemon-wide wait cannot be used because it is shorter
    // than one such delay. Polling is slow because each turn spawns systemctl.
    const observe = <T>(assertion: () => Promise<T>) =>
      withinServiceDeadline(deadline, () => vi.waitFor(assertion, { timeout: 30_000, interval: 500 }))
    // A restart, had the manager intended one, lands one restart delay after
    // the process ends. Watching past that is what turns "not restarted yet"
    // into "not restarted".
    const past = (active: OperationDeadline) => withinServiceDeadline(active, async () => {
      await delay(noRestartWindowMs, undefined, { signal: active.signal }).catch(() => undefined)
    })

    await throwaway.install(deadline)
    // The supervision policy is read back off the manager's parse of our unit,
    // not off the string we generated, and it is what the waits below are sized
    // against.
    const policy = await show(["Restart", "RestartUSec", "NRestarts", "ActiveState", "MainPID"], deadline)
    expect(policy.get("Restart")).toBe("on-failure")
    expect(policy.get("RestartUSec")).toBe(restartDelay)
    expect(policy.get("NRestarts")).toBe("0")
    expect(policy.get("ActiveState")).toBe("active")

    const first = await observe(async () => {
      const running = await show(["MainPID"], deadline)
      const main = Number(running.get("MainPID"))
      expect(main).toBeGreaterThan(0)
      // The manager's main process is the one that wrote the PID file, so the
      // process about to be crashed is the one this unit supervises and not
      // some other daemon that happens to be up.
      expect(Number(await readFile(ready, "utf8"))).toBe(main)
      throwaway.observed(main)
      return main
    })

    // A crash, driven through the manager rather than by a raw PID that could
    // have been reused. SIGKILL cannot be caught, and it is not one of the four
    // signals systemd counts as a clean exit, so the manager sees a failure.
    const crashed = await systemctl(["--user", "kill", "--signal=SIGKILL", "--kill-whom=main", unit], deadline)
    expect(crashed.code).toBe(0)

    // NRestarts is the manager's own count of automatic restarts, and under
    // Restart=on-failure it only moves for a failure, so this single property
    // is both "systemd restarted it" and "systemd called the crash a failure".
    const restarted = await observe(async () => {
      const state = await show(["NRestarts", "ActiveState", "SubState", "MainPID"], deadline)
      expect(state.get("NRestarts")).toBe("1")
      expect(state.get("ActiveState")).toBe("active")
      expect(state.get("SubState")).toBe("running")
      const main = Number(state.get("MainPID"))
      expect(main).toBeGreaterThan(0)
      expect(main).not.toBe(first)
      expect(Number(await readFile(ready, "utf8"))).toBe(main)
      throwaway.observed(main)
      return main
    })
    expect(() => process.kill(restarted, 0)).not.toThrow()
    // The daemon's own status reports the replacement, so a caller asking
    // after a crash is told the service is up rather than told nothing.
    expect(await withinServiceDeadline(deadline, () => serviceStatus({ platform: "linux", home }, effects)))
      .toMatchObject({ installed: true, running: true })

    // First negative: a deliberate stop is a job, not a failure, and a
    // supervisor that fights the operator over it is its own bug.
    const stopped = await systemctl(["--user", "stop", unit], deadline)
    expect(stopped.code).toBe(0)
    const afterStop = await show(["ActiveState", "SubState", "MainPID"], deadline)
    expect(afterStop.get("ActiveState")).toBe("inactive")
    expect(afterStop.get("SubState")).toBe("dead")
    expect(afterStop.get("MainPID")).toBe("0")
    await past(deadline)
    const stillStopped = await show(["ActiveState", "SubState", "MainPID"], deadline)
    expect(stillStopped.get("ActiveState")).toBe("inactive")
    expect(stillStopped.get("SubState")).toBe("dead")
    expect(stillStopped.get("MainPID")).toBe("0")
    expect(Number(await readFile(ready, "utf8"))).toBe(restarted)

    // Second negative, and the one the unit's own directive decides: a main
    // process that exits zero is a success, and on-failure must leave it
    // exited. Restart=always would revive it here while still passing the
    // crash half above.
    const restarting = await systemctl(["--user", "start", unit], deadline)
    expect(restarting.code).toBe(0)
    const clean = await observe(async () => {
      const state = await show(["ActiveState", "MainPID", "NRestarts"], deadline)
      expect(state.get("ActiveState")).toBe("active")
      // A start job the operator asked for is not an automatic restart, so the
      // manager's count goes back to zero and the assertion after the clean
      // exit is a comparison against a known number.
      expect(state.get("NRestarts")).toBe("0")
      const main = Number(state.get("MainPID"))
      expect(main).toBeGreaterThan(0)
      expect(Number(await readFile(ready, "utf8"))).toBe(main)
      throwaway.observed(main)
      return main
    })
    await withinServiceDeadline(deadline, () => writeFile(`${ready}.stop`, "stop"))
    await observe(async () => {
      const state = await show(["ActiveState", "SubState", "Result", "ExecMainCode", "ExecMainStatus"], deadline)
      expect(state.get("ActiveState")).toBe("inactive")
      expect(state.get("SubState")).toBe("dead")
      expect(state.get("Result")).toBe("success")
      // CLD_EXITED with status zero: the process ended on its own, cleanly.
      expect(state.get("ExecMainCode")).toBe("1")
      expect(state.get("ExecMainStatus")).toBe("0")
    })
    await past(deadline)
    const stayedExited = await show(["ActiveState", "SubState", "MainPID", "NRestarts"], deadline)
    expect(stayedExited.get("ActiveState")).toBe("inactive")
    expect(stayedExited.get("SubState")).toBe("dead")
    expect(stayedExited.get("MainPID")).toBe("0")
    expect(stayedExited.get("NRestarts")).toBe("0")
    expect(Number(await readFile(ready, "utf8"))).toBe(clean)
  })
}, supervisionBudget + cleanupBudget + 1_000)
