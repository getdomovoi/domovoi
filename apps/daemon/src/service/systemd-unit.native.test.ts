import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"

import { expect, it, vi } from "vitest"

import type { OperationDeadline } from "../operation-deadline.js"
import { waitForDaemon } from "../test-wait-for.js"
import { withinServiceDeadline } from "./deadline.js"
import { removeService, serviceStatus } from "./install.js"
import { cleanupBudget, lifecycleBudget, supervisionBudget, systemdConfigHome, systemdManagerAvailable, systemdProofRequired, withThrowawayUnit } from "./systemd-unit.test-support.js"

const host = {
  runtimeDirectory: process.env.XDG_RUNTIME_DIR ?? "",
  configHome: systemdConfigHome(process.env.XDG_CONFIG_HOME, homedir()),
}
const managerRunning = systemdManagerAvailable({
  platform: process.platform, runtimeDirectory: host.runtimeDirectory, required: systemdProofRequired(process.env.CI),
})
// The native supervision assertions read RestartSec back from the manager.
const restartDelay = "5s"
const noRestartWindowMs = 8_000

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
  }, host)
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
  }, host)
}, supervisionBudget + cleanupBudget + 1_000)
