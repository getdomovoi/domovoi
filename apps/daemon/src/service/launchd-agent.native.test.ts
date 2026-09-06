import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
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
// The scripted-manager tests never wait for launchd, so their budget only has
// to cover a temporary directory and a few file writes.
const scriptedBudget = 15_000
const productionLabel = "sh.domovoi.domovoid"
const productionAgent = `${productionLabel}.plist`
const uid = process.getuid?.() ?? -1
// The per-user GUI domain is the one the installer targets.
const domain = `gui/${uid}`
// launchd throttles a relaunch by its own minimum runtime rather than by a
// delay the unit declares, so the window that turns "not relaunched yet" into
// "not relaunched" is sized against the number the manager reports. A manager
// reporting more than this would make the test outlive its budget, so it
// refuses instead of quietly waiting longer.
const maximumThrottleSeconds = 20
// The domain probe runs while this file is being loaded, before any test
// deadline exists, so it carries its own bound. A launchctl that never answers
// has to fail the gate rather than hang the run.
const domainProbeTimeoutMs = 10_000

type DomainProbe = { reachable: boolean; detail: string }

// Only an answered, zero-status probe is a reachable domain. A launchctl that
// could not be spawned, one killed at the bound above, and a non-zero status
// are each unreachable, and each keeps its reason, because the gate below
// reports that reason by name.
function classifyDomainProbe(probe: Pick<SpawnSyncReturns<string>, "error" | "signal" | "status">): DomainProbe {
  if (probe.error !== undefined) return { reachable: false, detail: `launchctl could not be run: ${probe.error.message}` }
  if (probe.signal !== null) return { reachable: false, detail: `launchctl was killed by ${probe.signal} after ${domainProbeTimeoutMs}ms` }
  if (probe.status !== 0) return { reachable: false, detail: `launchctl print ${domain} exited with ${probe.status}` }
  return { reachable: true, detail: `${domain} answered` }
}

function runningInCi(environment: NodeJS.ProcessEnv): boolean {
  const flag = environment.CI
  return flag !== undefined && flag !== "" && flag !== "0" && flag.toLowerCase() !== "false"
}

// CI is fail loud; a developer machine is not. This file is the only native
// macOS proof there is, and a skipped test reports exactly like a passing one,
// so an unreachable domain on the macOS CI leg throws with the reason the probe
// gave. The workflow asserts the same domain beforehand, and this is a second
// lock on the same door rather than a restatement of it: a probe that fails
// only here, or that fails between the two steps, must still stop the run. Off
// CI an absent domain skips, which is the ordinary case for a plain ssh login
// with no GUI domain to reach, and every leg that is not macOS skips too.
function domainGate(environment: { platform: string; ci: boolean }, probe: DomainProbe): boolean {
  if (probe.reachable) return true
  if (environment.ci && environment.platform === "darwin") {
    throw new Error(`The macOS CI leg requires a reachable ${domain}, and the launchd test may not skip there: ${probe.detail}`)
  }
  return false
}

const domainReachable = domainGate(
  { platform: process.platform, ci: runningInCi(process.env) },
  process.platform === "darwin" && uid >= 0
    ? classifyDomainProbe(spawnSync("launchctl", ["print", domain], {
      encoding: "utf8",
      stdio: "ignore",
      timeout: domainProbeTimeoutMs,
      killSignal: "SIGKILL",
    }))
    : { reachable: false, detail: `${process.platform} has no per-user launchd domain for uid ${uid}` },
)

// The throwaway agent's own names. `agentPath` is absent until the throwaway
// home exists, and while it is absent no bootstrap is a command this test may
// run at all.
type FenceScope = { domain: string; label: string; target: string; agentPath?: string }

// Every launchctl this test runs passes through here. It rewrites the daemon's
// own agent label to the throwaway label, and then requires the whole command
// line to be one of the shapes this test needs. The fence is an allowlist and
// not a list of refusals, because the dangerous commands are the ones nobody
// thought to name: `bootout gui/501` retires every agent the operator has, and
// `bootstrap gui/501 ~/Library/LaunchAgents/anything.plist` loads a file this
// test never wrote. Neither is on the list, so neither runs, and that stays
// true if the installer's command list changes.
function launchctlFence(command: string, args: readonly string[], scope: FenceScope): string[] {
  if (command !== "launchctl") throw new Error(`This test may only run launchctl, not ${command}`)
  const scoped = args.map((argument) => (argument === `${scope.domain}/${productionLabel}` ? scope.target : argument))
  const allowed: readonly (readonly string[])[] = [
    ["print", scope.target],
    ["bootout", scope.target],
    ["kill", "SIGKILL", scope.target],
    ...(scope.agentPath === undefined ? [] : [["bootstrap", scope.domain, scope.agentPath]]),
  ]
  const permitted = allowed.some((shape) => shape.length === scoped.length
    && shape.every((word, index) => word === scoped[index]))
  if (!permitted) throw new Error(`This test may not run launchctl ${scoped.join(" ")}`)
  return scoped
}

// launchd answers with the canonical path. On macOS the temporary directory is
// reached through a symlink, so a fixture holding `/var/folders/...` is told
// about `/private/var/folders/...`, and comparing the strings fails on two
// names for one file. Both sides are resolved instead. A path that cannot be
// resolved is not the same file as one that can.
function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

// The preflight answers one of three things, and only absence may lead to a
// bootstrap. Absence has to be launchd saying so: a non-zero status alone also
// covers a launchctl that could not be spawned, a malformed domain and a
// manager that is not answering, and treating any of those as absence is how
// this test would bootstrap over, and later retire, an agent it does not own.
type Presence = "present" | "absent" | "unknown"

function presenceOf(probe: CapturedRun, label: string): Presence {
  if (probe.code === 0) return "present"
  const answer = `${probe.stdout}\n${probe.stderr ?? ""}`
  const missing = /(?:could not find|no such) service/i.test(answer) && answer.includes(label)
  return missing ? "absent" : "unknown"
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
// `base` is a parameter so the scripted tests at the end of this file can drive
// this same preflight and this same cleanup without a real launchd; the native
// tests take the default.
async function withThrowawayAgent(
  budgetMs: number,
  body: (throwaway: ThrowawayAgent, deadline: OperationDeadline) => Promise<void>,
  base: ServiceEffects = nodeServiceEffects(),
): Promise<void> {
  // This is the native boundary, not an interception of launchd. The label is a
  // UUID suffix on the production one, so it can never collide with the agent
  // the operator installed while still being classified by the daemon's own
  // missing-service matcher. Bootstrapping names a path, so every file this
  // test writes stays inside its throwaway home and nothing lands in the
  // operator's own ~/Library/LaunchAgents.
  const label = `${productionLabel}.native-test-${randomUUID()}`
  const target = `${domain}/${label}`
  const scope: FenceScope = { domain, label, target }
  const deadline = OperationDeadline.start(budgetMs)
  const launchctl = (args: readonly string[], active: OperationDeadline) =>
    withinServiceDeadline(active, () => base.capture("launchctl", launchctlFence("launchctl", args, scope), active))
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
  // The cleanup may ask launchd to retire this label only once two things are
  // true: launchd said the label was unused, and this test went on to ask
  // launchd to bootstrap it. Until then nothing of ours is in the domain, and a
  // removal could only reach an agent somebody else owns.
  let bootoutArmed = false
  try {
    const created = await withinServiceDeadline(deadline, () => mkdtemp(join(tmpdir(), "domovoi-launchd-")))
    installedHome = created
    // Resolved once, so every path derived from the home is already the one
    // launchd reports back rather than a symlinked spelling of it.
    const home = await withinServiceDeadline(deadline, () => realpath(created))
    installedHome = home
    const agentPath = posix.join(home, "Library", "LaunchAgents", productionAgent)
    scope.agentPath = agentPath
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
      run: (command, args, active) => base.run(command, launchctlFence(command, args, scope), active),
      capture: (command, args, active) => base.capture(command, launchctlFence(command, args, scope), active),
    }

    // Refuse rather than overwrite. Nothing is bootstrapped until the manager
    // and the filesystem both agree this label is unused, and a manager that
    // cannot be read is not agreement.
    const before = await launchctl(["print", target], deadline)
    const presence = presenceOf(before, label)
    if (presence === "present") throw new Error(`${label} already exists in ${domain}`)
    if (presence === "unknown") {
      throw new Error(`launchd did not say whether ${label} exists, so this test creates and removes nothing: ${before.stderr ?? ""}`.trim())
    }
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
      install: (active) => withinServiceDeadline(active, () => {
        // Armed here, immediately before the bootstrap, and never earlier. A
        // body that fails before this point has put nothing in the domain, and
        // a cleanup that boots out anyway can only reach somebody else's agent.
        // A bootstrap that fails after launchd accepted the job still leaves
        // one to retire, so arming precedes the attempt rather than following
        // a successful one.
        bootoutArmed = true
        return installService({
          platform: "darwin",
          execPath: script,
          runtime: process.execPath,
          home,
          uid,
          configuration: createServiceConfiguration({}, { homeDirectory: home, platform: "darwin", workingDirectory: home }),
        }, effects)
      }),
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
      if (bootoutArmed) {
        // An install that failed after launchd accepted the job still leaves
        // one to retire, and booting out a label that was never bootstrapped
        // only answers non-zero.
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
      }
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
    // the process the agent names. The assertion is about the file launchd
    // named, not about the spelling it used to name it.
    const loaded = await printed(deadline)
    const reported = loaded.get("path")
    expect(reported, "launchctl print reported no path for the agent").toBeDefined()
    expect(samePath(reported ?? "", agentPath), `launchctl reported ${reported}, not ${agentPath}`).toBe(true)
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

// The two tests above run on macOS and nowhere else, but the machinery that
// keeps them off the operator's own agents is the part that must never be
// wrong. Everything below drives that machinery on every platform, with a
// scripted manager standing in for launchd, so a refusal that regresses fails
// here rather than on somebody's laptop.

// launchd names the service it was asked about, which is what lets the
// preflight tell absence apart from a manager it could not read at all.
const notFound = (service: string): CapturedRun => ({
  code: 113,
  stdout: "",
  stderr: `Could not find service "${service}" in domain for ${domain}\n`,
})

const printedAgent = (label: string, path: string): CapturedRun => ({
  code: 0,
  stdout: [`${domain}/${label} = {`, `\tpath = ${path}`, "\tstate = running", "}"].join("\n"),
  stderr: "",
})

type ManagerCall = { command: string; args: readonly string[] }

// Only the manager is scripted. Every file these tests drive is really written,
// into a real throwaway home, so this exercises the preflight and the cleanup
// as they run for real rather than a paraphrase of them. `print` is answered by
// call number, and every other command succeeds silently.
function scriptedManager(print: (call: number, service: string) => CapturedRun | Error): { effects: ServiceEffects; calls: ManagerCall[] } {
  const base = nodeServiceEffects()
  const calls: ManagerCall[] = []
  let asked = 0
  const answer = (command: string, args: readonly string[]): CapturedRun => {
    calls.push({ command, args: [...args] })
    if (args[0] !== "print") return { code: 0, stdout: "", stderr: "" }
    asked += 1
    const scripted = print(asked, args[1] ?? "")
    if (scripted instanceof Error) throw scripted
    return scripted
  }
  return {
    calls,
    effects: {
      ...base,
      run: async (command, args) => { answer(command, args) },
      capture: async (command, args) => answer(command, args),
    },
  }
}

const commands = (calls: readonly ManagerCall[]) => calls.map((call) => `${call.command} ${call.args.join(" ")}`)
const removals = (calls: readonly ManagerCall[]) => commands(calls).filter((command) => /\b(?:bootout|bootstrap|kill)\b/.test(command))

it("runs only the launchctl commands the throwaway agent needs", () => {
  const label = `${productionLabel}.native-test-${randomUUID()}`
  const agentPath = `/tmp/domovoi-launchd-scripted/Library/LaunchAgents/${productionAgent}`
  const scope: FenceScope = { domain, label, target: `${domain}/${label}`, agentPath }
  const operatorAgent = `/Users/operator/Library/LaunchAgents/${productionAgent}`

  // The installer's own command lines, with the daemon's label rewritten to the
  // throwaway one. These are the only shapes that may reach a real launchd.
  expect(launchctlFence("launchctl", ["print", `${domain}/${productionLabel}`], scope)).toEqual(["print", scope.target])
  expect(launchctlFence("launchctl", ["bootout", `${domain}/${productionLabel}`], scope)).toEqual(["bootout", scope.target])
  expect(launchctlFence("launchctl", ["bootstrap", domain, agentPath], scope)).toEqual(["bootstrap", domain, agentPath])
  expect(launchctlFence("launchctl", ["kill", "SIGKILL", scope.target], scope)).toEqual(["kill", "SIGKILL", scope.target])

  // A domain wide mutation names no label at all, so a fence that only checked
  // labels lets it through, and it retires every agent the operator has.
  expect(() => launchctlFence("launchctl", ["bootout", domain], scope)).toThrow(`This test may not run launchctl bootout ${domain}`)
  expect(() => launchctlFence("launchctl", ["kill", "SIGKILL", domain], scope)).toThrow(/may not run launchctl kill/)
  // A plist outside the throwaway home is a file this test never wrote, whether
  // it is the operator's own agent or any other.
  expect(() => launchctlFence("launchctl", ["bootstrap", domain, operatorAgent], scope))
    .toThrow(`This test may not run launchctl bootstrap ${domain} ${operatorAgent}`)
  expect(() => launchctlFence("launchctl", ["bootstrap", domain, "/Users/operator/Library/LaunchAgents/other.plist"], scope))
    .toThrow(/may not run launchctl bootstrap/)
  // A label the operator owns, named directly rather than through the rewrite.
  expect(() => launchctlFence("launchctl", ["bootout", `${domain}/${productionLabel}.other`], scope)).toThrow(/may not run launchctl bootout/)
  expect(() => launchctlFence("launchctl", ["print", productionLabel], scope)).toThrow(/may not run launchctl print/)
  // Another user's domain, and the system domain.
  expect(() => launchctlFence("launchctl", ["bootout", `gui/${uid + 1}/${label}`], scope)).toThrow(/may not run launchctl bootout/)
  expect(() => launchctlFence("launchctl", ["bootout", `system/${label}`], scope)).toThrow(/may not run launchctl bootout/)
  // An extra argument makes a different command, including one launchctl would
  // ignore.
  expect(() => launchctlFence("launchctl", ["bootout", scope.target, operatorAgent], scope)).toThrow(/may not run launchctl bootout/)
  // Anything that is not the service manager.
  expect(() => launchctlFence("rm", ["-rf", operatorAgent], scope)).toThrow("This test may only run launchctl, not rm")

  // Before the throwaway home exists there is no legal bootstrap at all.
  const unopened: FenceScope = { domain, label, target: `${domain}/${label}` }
  expect(() => launchctlFence("launchctl", ["bootstrap", domain, agentPath], unopened)).toThrow(/may not run launchctl bootstrap/)
})

it("refuses an agent that already exists, and removes nothing", async () => {
  const collision = scriptedManager((call, service) => (call === 1
    ? printedAgent(service, `/Users/operator/Library/LaunchAgents/${productionAgent}`)
    : notFound(service)))
  let entered = false
  await expect(withThrowawayAgent(scriptedBudget, async () => { entered = true }, collision.effects))
    .rejects.toThrow(new RegExp(`already exists in ${domain}`))
  expect(entered).toBe(false)
  // The point of the finding: the preflight refused, so the cleanup has no
  // agent of its own to retire and must not ask launchd to retire the one it
  // found. The only command that ran is the probe that found it.
  expect(removals(collision.calls)).toEqual([])
  expect(commands(collision.calls)).toHaveLength(1)
}, scriptedBudget + cleanupBudget + 1_000)

it("treats a manager it cannot read as unknown, not as absent", async () => {
  const answers: readonly (CapturedRun | Error)[] = [
    new Error("spawn launchctl ENOENT"),
    { code: 1, stdout: "", stderr: "spawn launchctl ENOENT" },
    { code: 1, stdout: "", stderr: "Bad request.\n" },
    { code: 1, stdout: "", stderr: "" },
    // The right shape of failure, but naming an agent this test did not create.
    { code: 113, stdout: "", stderr: `Could not find service "${productionLabel}" in domain for ${domain}` },
  ]
  for (const answer of answers) {
    const unreadable = scriptedManager(() => answer)
    let entered = false
    await expect(withThrowawayAgent(scriptedBudget, async () => { entered = true }, unreadable.effects))
      .rejects.toThrow(answer instanceof Error ? /ENOENT/ : /did not say whether/)
    expect(entered).toBe(false)
    expect(removals(unreadable.calls)).toEqual([])
  }
}, scriptedBudget + cleanupBudget + 1_000)

it("arms the removal only once a bootstrap has been attempted", async () => {
  const withoutBootstrap = scriptedManager((_call, service) => notFound(service))
  let probed: string | undefined
  await withThrowawayAgent(scriptedBudget, async (throwaway) => {
    // A body that reads the agent path and nothing else has put nothing in the
    // domain. There is nothing to boot out, and nothing that may be.
    expect(throwaway.agentPath.endsWith(`/Library/LaunchAgents/${productionAgent}`)).toBe(true)
    probed = throwaway.target
  }, withoutBootstrap.effects)
  expect(commands(withoutBootstrap.calls)).toEqual([`launchctl print ${probed}`])

  const withBootstrap = scriptedManager((_call, service) => notFound(service))
  let bootstrapped: string | undefined
  let installedAgent: string | undefined
  await withThrowawayAgent(scriptedBudget, async (throwaway, deadline) => {
    const plan = await throwaway.install(deadline)
    installedAgent = plan.kind === "file" ? plan.path : undefined
    bootstrapped = throwaway.target
  }, withBootstrap.effects)
  expect(installedAgent).toBeDefined()
  // A bootstrap was attempted, so the cleanup owes the domain a removal, and it
  // names the throwaway label rather than the daemon's own.
  expect(removals(withBootstrap.calls)).toEqual([
    `launchctl bootstrap ${domain} ${installedAgent}`,
    `launchctl bootout ${bootstrapped}`,
  ])
  expect(commands(withBootstrap.calls).some((command) => command.endsWith(`/${productionLabel}`))).toBe(false)
}, scriptedBudget + cleanupBudget + 1_000)

it("compares the file launchd names, not the spelling it uses", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "domovoi-launchd-path-")))
  try {
    const agents = join(home, "Library", "LaunchAgents")
    await mkdir(agents, { recursive: true })
    await writeFile(join(agents, productionAgent), "")
    // `/var` is a symlink to `/private/var` on macOS, which is why launchd
    // answers a fixture holding one path with the other spelling of it. This
    // is the assertion that failed on the first hosted run.
    await symlink(home, join(home, "private"))
    const reported = join(home, "private", "Library", "LaunchAgents", productionAgent)
    const expected = join(agents, productionAgent)
    expect(reported).not.toBe(expected)
    expect(samePath(reported, expected)).toBe(true)
    expect(samePath(join(agents, "absent.plist"), expected)).toBe(false)
    expect(samePath(expected, expected)).toBe(true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it("fails the macOS CI leg rather than skipping when the domain is unreachable", () => {
  const unreachable = classifyDomainProbe({ signal: null, status: 113 })
  expect(unreachable.reachable).toBe(false)
  // The ways the bounded probe can fail to answer, each keeping its reason.
  expect(classifyDomainProbe({ error: new Error("spawn launchctl ENOENT"), signal: null, status: null }).detail).toContain("ENOENT")
  expect(classifyDomainProbe({ signal: "SIGKILL", status: null }).detail).toContain("SIGKILL")
  expect(classifyDomainProbe({ signal: null, status: 1 }).detail).toContain("exited with 1")
  expect(classifyDomainProbe({ signal: null, status: 0 }).reachable).toBe(true)

  // The failure this replaces: a probe that did not answer used to skip both
  // native tests even on CI, and a skipped macOS leg reports as a passing one.
  expect(() => domainGate({ platform: "darwin", ci: true }, unreachable)).toThrow(/requires a reachable gui/)
  expect(domainGate({ platform: "darwin", ci: true }, { reachable: true, detail: "" })).toBe(true)
  // A developer machine without a GUI login still skips, and so does every leg
  // that is not macOS.
  expect(domainGate({ platform: "darwin", ci: false }, unreachable)).toBe(false)
  expect(domainGate({ platform: "linux", ci: true }, unreachable)).toBe(false)
  expect(domainGate({ platform: "win32", ci: true }, unreachable)).toBe(false)

  expect(runningInCi({ CI: "true" })).toBe(true)
  expect(runningInCi({ CI: "1" })).toBe(true)
  expect(runningInCi({})).toBe(false)
  expect(runningInCi({ CI: "" })).toBe(false)
  expect(runningInCi({ CI: "false" })).toBe(false)
  expect(runningInCi({ CI: "0" })).toBe(false)
})
