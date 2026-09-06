import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { expect, it, vi } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { waitForDaemon } from "../test-wait-for.js"
import { createServiceConfiguration, serviceConfigurationPath } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"
import { installService, nodeServiceEffects, removeService, serviceStatus, type CapturedRun, type ServiceEffects, type ServicePlan } from "./install.js"

const lifecycleBudget = 60_000
const supervisionBudget = 90_000
const cleanupBudget = 30_000
const productionLabel = "sh.domovoi.domovoid"
const productionAgent = `${productionLabel}.plist`
const uid = process.getuid?.() ?? -1
// The per-user GUI domain is the one the installer targets. A launchd domain
// target is a bare word before the first slash, which no absolute path is, so
// this recognises a domain argument without also matching the plist path.
const domain = `gui/${uid}`
const domainTarget = /^(?:system|user|gui|pid|login|session)(?:\/|$)/
// launchd throttles a relaunch by its own minimum runtime rather than by a
// delay the unit declares, so the window that turns "not relaunched yet" into
// "not relaunched" is sized against the number the manager reports. A manager
// reporting more than this would make the test outlive its budget, so it
// refuses instead of quietly waiting longer.
const maximumThrottleSeconds = 20
// The gate is the per-user GUI domain itself. A session without one, such as a
// plain ssh login, cannot reach a launch agent at all and skips. The macOS CI
// leg asserts this same domain before running the suite, so a runner that lost
// it fails there rather than skipping silently.
const domainReachable = process.platform === "darwin" && uid >= 0
  && spawnSync("launchctl", ["print", domain], { stdio: "ignore" }).status === 0

// Every launchctl this test runs passes through here. It rewrites the daemon's
// own agent label to the UUID label this test created, refuses any command that
// is not the service manager, refuses any domain that is not this user's own,
// and refuses to name the operator's label, so no agent they own is reachable
// even if the installer's command list changes.
function userScoped(command: string, args: readonly string[], label: string): string[] {
  if (command !== "launchctl") throw new Error(`This test may only run launchctl, not ${command}`)
  const scoped = args.map((argument) => (argument === `${domain}/${productionLabel}` ? `${domain}/${label}` : argument))
  for (const argument of scoped) {
    if (argument === productionLabel || argument.endsWith(`/${productionLabel}`)) {
      throw new Error(`This test may not name the agent ${productionLabel}`)
    }
    if (!domainTarget.test(argument)) continue
    if (argument !== domain && argument !== `${domain}/${label}`) {
      throw new Error(`This test may only address ${domain}, not ${argument}`)
    }
  }
  return scoped
}

type ThrowawayAgent = {
  label: string
  target: string
  home: string
  agentPath: string
  configurationPath: string
  readyPath: string
  effects: ServiceEffects
  launchctl: (args: readonly string[], active: OperationDeadline) => Promise<CapturedRun>
  printed: (active: OperationDeadline) => Promise<Map<string, string>>
  install: (active: OperationDeadline) => Promise<ServicePlan>
  observed: (pid: number) => void
}

// One throwaway agent, one chokepoint, one preflight and one cleanup, shared by
// every native test in this file. A second copy of this machinery is a second
// chance to name the operator's own agent, so there is only ever this one.
async function withThrowawayAgent(
  budgetMs: number,
  body: (throwaway: ThrowawayAgent, deadline: OperationDeadline) => Promise<void>,
): Promise<void> {
  // This is the native boundary, not an interception of launchd. The label is a
  // UUID suffix on the production one, so it can never collide with the agent
  // the operator installed while still being classified by the daemon's own
  // missing-service matcher. Bootstrapping names a path, so every file this
  // test writes stays inside its throwaway home and nothing lands in the
  // operator's own ~/Library/LaunchAgents.
  const label = `${productionLabel}.native-test-${randomUUID()}`
  const target = `${domain}/${label}`
  const deadline = OperationDeadline.start(budgetMs)
  const base = nodeServiceEffects()
  const launchctl = (args: readonly string[], active: OperationDeadline) =>
    withinServiceDeadline(active, () => base.capture("launchctl", userScoped("launchctl", args, label), active))
  // Fields come back one `key = value` per line, indented, with nested blocks
  // that repeat some names. Only the first occurrence of a name is the job's
  // own field, so a nested block cannot shadow it.
  const printed = async (active: OperationDeadline) => {
    const shown = await launchctl(["print", target], active)
    expect(shown.code, shown.stderr).toBe(0)
    const fields = new Map<string, string>()
    for (const line of shown.stdout.split("\n")) {
      const separator = line.indexOf(" = ")
      if (separator < 0) continue
      const key = line.slice(0, separator).trim()
      if (!fields.has(key)) fields.set(key, line.slice(separator + 3).trim())
    }
    return fields
  }
  let installedHome: string | undefined
  let readyPath: string | undefined
  let pid: number | undefined
  try {
    const home = await withinServiceDeadline(deadline, () => mkdtemp(join(tmpdir(), "domovoi-launchd-")))
    installedHome = home
    const agentPath = posix.join(home, "Library", "LaunchAgents", productionAgent)
    const configurationPath = serviceConfigurationPath(home, "darwin")
    const ready = join(posix.dirname(configurationPath), "ready")
    readyPath = ready
    // Nothing this test writes may leave the throwaway home, and the one file
    // launchd is asked to read is the agent inside it.
    const scopedPath = (path: string) => {
      if (path !== home && !path.startsWith(`${home}/`)) throw new Error(`This test may not touch ${path}`)
      return path
    }
    // The label lives in the plist body, not in its name, so the chokepoint has
    // to reach the generated file as well as the command line. Requiring
    // exactly one declaration keeps a future generator change from leaving a
    // second copy of the production label behind.
    const relabelled = (path: string, contents: string) => {
      if (path !== agentPath) return contents
      const declaration = `<string>${productionLabel}</string>`
      if (contents.split(declaration).length !== 2) {
        throw new Error("the generated launch agent did not declare exactly one production label")
      }
      return contents.replace(declaration, `<string>${label}</string>`)
    }
    const effects: ServiceEffects = {
      ...base,
      // Exclusion is per OS user, so the daemon's real lock would be the one
      // file this test touches outside its own home. Point it at the throwaway
      // home instead of contending with the operator's own installs.
      claimServiceOperation: nodeServiceEffects({ userHomeDirectory: home }).claimServiceOperation,
      write: (path, contents, active) => base.write(scopedPath(path), relabelled(path, contents), active),
      exists: (path, active) => base.exists(scopedPath(path), active),
      remove: (path, active) => base.remove(scopedPath(path), active),
      run: (command, args, active) => base.run(command, userScoped(command, args, label), active),
      capture: (command, args, active) => base.capture(command, userScoped(command, args, label), active),
    }

    // Refuse rather than overwrite. Nothing is bootstrapped until the manager
    // and the filesystem both agree this label is unused.
    const before = await launchctl(["print", target], deadline)
    if (before.code === 0) throw new Error(`${label} already exists in ${domain}`)
    if (existsSync(agentPath)) throw new Error(`${label} already has files on disk`)

    const script = join(home, "agent.mjs")
    await withinServiceDeadline(deadline, () => copyFile(new URL("../../test-fixtures/service-process.mjs", import.meta.url), script))

    await body({
      label,
      target,
      home,
      agentPath,
      configurationPath,
      readyPath: ready,
      effects,
      launchctl,
      printed,
      install: (active) => withinServiceDeadline(active, () => installService({
        platform: "darwin",
        execPath: script,
        runtime: process.execPath,
        home,
        uid,
        configuration: createServiceConfiguration({}, { homeDirectory: home, platform: "darwin", workingDirectory: home }),
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
      // Unconditional: an install that failed after launchd accepted the job
      // still leaves one to retire, and booting out a label that was never
      // bootstrapped only answers non-zero.
      await launchctl(["bootout", target], cleanup)
      const started = pid
      if (started !== undefined) await withinServiceDeadline(cleanup, () => waitForDaemon(() => {
        cleanup.throwIfExpired()
        expect(() => process.kill(started, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
      }))
      // Booting out is asynchronous: the command returns before launchd has
      // finished retiring the job, so this waits for the domain to stop
      // answering for the label rather than sampling it once.
      await withinServiceDeadline(cleanup, () => vi.waitFor(async () => {
        cleanup.throwIfExpired()
        expect((await launchctl(["print", target], cleanup)).code).not.toBe(0)
      }, { timeout: 10_000, interval: 250 }))
      const created = installedHome
      if (created !== undefined) await withinServiceDeadline(cleanup, () => rm(created, { recursive: true, force: true }))
    } finally { cleanup.clear() }
  }
}

it.runIf(domainReachable)("installs, reports and removes a real launchd user agent", async () => {
  await withThrowawayAgent(lifecycleBudget, async (throwaway, deadline) => {
    const { agentPath, configurationPath, effects, home, printed, readyPath: ready, target } = throwaway
    const plan = await throwaway.install(deadline)
    expect(plan).toMatchObject({ kind: "file", path: agentPath })

    let pid: number | undefined
    await withinServiceDeadline(deadline, () => waitForDaemon(async () => {
      deadline.throwIfExpired()
      pid = Number(await readFile(ready, "utf8"))
      throwaway.observed(pid)
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
      expect(() => process.kill(pid!, 0)).not.toThrow()
    }))

    // The manager, not the generated string, is the witness: it read this file,
    // registered it in this user's own domain as a launch agent, and is running
    // the process the agent names.
    const loaded = await printed(deadline)
    expect(loaded.get("path")).toBe(agentPath)
    expect(loaded.get("type")).toBe("LaunchAgent")
    expect(loaded.get("state")).toBe("running")
    expect(loaded.get("domain")).toContain(domain)
    expect(loaded.get("properties")).toContain("runatload")
    expect(Number(loaded.get("pid"))).toBe(pid)

    const status = await withinServiceDeadline(deadline, () => serviceStatus({ platform: "darwin", home, uid }, effects))
    expect(status).toMatchObject({ installed: true, running: true })
    expect(status.detail).toBe(`${agentPath} is loaded`)

    const removal = await withinServiceDeadline(deadline, () => removeService({ platform: "darwin", home, uid }, effects))
    expect(removal).toMatchObject({ kind: "file", path: agentPath })
    await withinServiceDeadline(deadline, () => waitForDaemon(() => {
      deadline.throwIfExpired()
      expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    }))
    // Booting out is asynchronous: launchctl returns when launchd accepts the
    // request, not when the job is gone, so the domain is polled rather than
    // sampled once. Sampling here would be the same race that makes an
    // immediate re-bootstrap fail with an input/output error.
    await withinServiceDeadline(deadline, () => vi.waitFor(async () => {
      deadline.throwIfExpired()
      expect((await throwaway.launchctl(["print", target], deadline)).code).not.toBe(0)
    }, { timeout: 10_000, interval: 250 }))
    expect(existsSync(agentPath)).toBe(false)
    expect(existsSync(configurationPath)).toBe(false)
    expect(await withinServiceDeadline(deadline, () => serviceStatus({ platform: "darwin", home, uid }, effects)))
      .toMatchObject({ installed: false, running: false })
  })
}, lifecycleBudget + cleanupBudget + 1_000)

it.runIf(domainReachable)("relaunches a crashed agent and leaves a cleanly exited one exited", async () => {
  await withThrowawayAgent(supervisionBudget, async (throwaway, deadline) => {
    const { effects, home, printed, readyPath: ready, target } = throwaway
    // Every wait here is bounded, and none of them may outlive the shared
    // deadline; a manager that never answers fails the test rather than
    // hanging it. Polling is slow because each turn spawns launchctl.
    const observe = <T>(assertion: () => Promise<T>) =>
      withinServiceDeadline(deadline, () => vi.waitFor(assertion, { timeout: 45_000, interval: 500 }))

    await throwaway.install(deadline)
    const first = await observe(async () => {
      const running = await printed(deadline)
      expect(running.get("state")).toBe("running")
      const main = Number(running.get("pid"))
      expect(main).toBeGreaterThan(0)
      // The manager's process is the one that wrote the PID file, so the
      // process about to be crashed is the one this agent supervises and not
      // some other daemon that happens to be up.
      expect(Number(await readFile(ready, "utf8"))).toBe(main)
      throwaway.observed(main)
      return { main, runs: Number(running.get("runs")), throttle: Number(running.get("minimum runtime")) }
    })
    expect(first.runs).toBeGreaterThanOrEqual(1)
    // launchd, not the agent, decides how long a relaunch waits, so the window
    // below is sized off the manager's own report rather than a constant.
    expect(Number.isSafeInteger(first.throttle)).toBe(true)
    expect(first.throttle).toBeGreaterThan(0)
    expect(first.throttle).toBeLessThanOrEqual(maximumThrottleSeconds)
    const noRelaunchWindowMs = (first.throttle + 5) * 1_000

    // A crash, driven through the manager rather than by a raw PID that could
    // have been reused. SIGKILL cannot be caught, so the process cannot exit
    // zero and KeepAlive's SuccessfulExit rule has to relaunch it.
    const crashed = await throwaway.launchctl(["kill", "SIGKILL", target], deadline)
    expect(crashed.code, crashed.stderr).toBe(0)

    // `runs` is the manager's own count of how many times it has started this
    // job, so an increment is launchd saying it started the replacement. A
    // changed PID alone would not say who started it. The count belongs to one
    // bootstrap, so it is only read as a delta across a crash, never across a
    // bootout and a fresh bootstrap.
    const relaunched = await observe(async () => {
      const state = await printed(deadline)
      expect(Number(state.get("runs"))).toBe(first.runs + 1)
      expect(state.get("state")).toBe("running")
      const main = Number(state.get("pid"))
      expect(main).toBeGreaterThan(0)
      expect(main).not.toBe(first.main)
      expect(Number(await readFile(ready, "utf8"))).toBe(main)
      throwaway.observed(main)
      return main
    })
    expect(() => process.kill(relaunched, 0)).not.toThrow()
    // The daemon's own status reports the replacement, so a caller asking
    // after a crash is told the service is up rather than told nothing.
    expect(await withinServiceDeadline(deadline, () => serviceStatus({ platform: "darwin", home, uid }, effects)))
      .toMatchObject({ installed: true, running: true })

    // The negative, and the one the agent's own KeepAlive dictionary decides: a
    // process that exits zero is a success, and `SuccessfulExit` false must
    // leave it exited. A bare `KeepAlive` true would revive it here while still
    // passing the crash half above.
    await withinServiceDeadline(deadline, () => writeFile(`${ready}.stop`, "stop"))
    await observe(async () => {
      deadline.throwIfExpired()
      expect(() => process.kill(relaunched, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    })
    // A relaunch, had the manager intended one, lands one throttle interval
    // after the process ends. Watching past that is what turns "not relaunched
    // yet" into "not relaunched".
    await withinServiceDeadline(deadline, async () => {
      await delay(noRelaunchWindowMs, undefined, { signal: deadline.signal }).catch(() => undefined)
    })
    const exited = await printed(deadline)
    expect(Number(exited.get("runs"))).toBe(first.runs + 1)
    // A throttled relaunch is reported as pending rather than as absent, so
    // "not running" alone would let a launchd that intended to revive the job
    // pass this half. Both states have to be excluded.
    expect(exited.get("state")).not.toBe("running")
    expect(exited.get("state")).not.toBe("spawn scheduled")
    expect(() => process.kill(relaunched, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
    expect(Number(await readFile(ready, "utf8"))).toBe(relaunched)
  })
}, supervisionBudget + cleanupBudget + 1_000)
