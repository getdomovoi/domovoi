import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it, vi } from "vitest"

import { ProcessTreeUnconfirmedError } from "./guest-supervisor.js"
import {
  launchGuestChild, parseGuestProcessStat, parseWindowsProcessAnswer,
  ProcessExitedBeforeIdentityError, windowsBootId, windowsProcessAlive, windowsProcessIdentity, windowsProcessQueryCommand,
} from "./supervisor-process.js"
import { guestProcessIdentitySchema } from "./supervisor-record.js"

// On Windows a stop ends the child's tree with taskkill.exe. No test runs it:
// this ends the test's own child directly, and is unused on other hosts.
const withoutTaskkill = { treeKill: async (pid: number) => { process.kill(pid, "SIGKILL") } }

it("reads start ticks after the final process-name delimiter and rejects zombies", () => {
  const stat = "123 (name ) with spaces) S " + Array(18).fill("0").join(" ") + " 777 0"
  expect(parseGuestProcessStat(stat)).toEqual({ start: "777", alive: true })
  expect(parseGuestProcessStat(stat.replace(") S ", ") Z "))).toEqual({ start: "777", alive: false })
  expect(() => parseGuestProcessStat("unreadable")).toThrow()
})

it("records a real failed spawn without inventing a pid or successful exit", async () => {
  const launched = await launchGuestChild(join(tmpdir(), "missing-" + randomUUID()), [])
  expect(launched).toEqual({ state: "failed", errorCode: "ENOENT" })
})

it("waits for an owned live child to exit on stop", async () => {
  const launched = await launchGuestChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    ...withoutTaskkill, identify: (pid) => ({ pid, start: "123", bootId: randomUUID() }),
  })
  expect(launched.state).toBe("started")
  if (launched.state !== "started") throw new Error("child did not start")
  try {
    const exited = await launched.child.stop()
    expect(await launched.child.exited).toEqual(exited)
    expect(exited.code !== null || exited.signal !== null).toBe(true)
  } finally { await launched.child.stop() }
})

it("stops a real child before refusing unavailable birth identity", async () => {
  const failure = new Error("identity probe failed")
  await expect(launchGuestChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    ...withoutTaskkill, identify: () => { throw failure },
  })).rejects.toBe(failure)
})

// Decided 2026-09-17 (SHIP-PLAN S1.1): the Windows logon task runs the same
// supervisor loop as the WSL guest. Windows has no /proc, so a process is
// identified by its pid and its creation time as Task Scheduler's own CIM
// provider reports it, and the boot by the System process's creation time.
// These answers are injected: no test runs a real PowerShell.
describe("Windows process identity", () => {
  afterEach(() => { vi.unstubAllEnvs() })
  const boot = "134041896000000000"
  const start = "134042000123456780"

  it("reads the boot and process creation times from one marked line", () => {
    expect(parseWindowsProcessAnswer(`domovoi-process:${boot}:${start}\r\n`)).toEqual({ boot, start })
    expect(parseWindowsProcessAnswer(`domovoi-process:${boot}:missing\r\n`)).toEqual({ boot, start: null })
    for (const text of ["", "domovoi-process:", `domovoi-process:${boot}`, `domovoi-process:x:${start}`, `domovoi-process:${boot}:${start}\ndomovoi-process:${boot}:${start}`, `Status: ${start}`]) {
      expect(() => parseWindowsProcessAnswer(text), text).toThrow("Windows did not report a process creation time")
    }
  })

  // Review of #698: a process that is there but reports no creation time is
  // not a process that is gone. The query says which, and only absence reads
  // as missing; the other refuses.
  it("refuses a present process that reports no creation time, rather than reading it as gone", () => {
    expect(() => parseWindowsProcessAnswer(`domovoi-process:${boot}:unknown\r\n`)).toThrow("Windows reported the process without a creation time")
    vi.stubEnv("SystemRoot", "C:\\Windows")
    const script = Buffer.from(windowsProcessQueryCommand(4242).args.at(-1)!, "base64").toString("utf16le")
    expect(script).toContain("if ($null -eq $process) { 'missing' }")
    expect(script).toContain("elseif ($null -eq $process.CreationDate) { 'unknown' }")
  })

  it("derives a stable boot identity in the record's UUID form", () => {
    expect(windowsBootId(boot)).toBe(windowsBootId(boot))
    expect(windowsBootId(boot)).not.toBe(windowsBootId("134041896000000010"))
    expect(guestProcessIdentitySchema.shape.bootId.safeParse(windowsBootId(boot)).success).toBe(true)
  })

  it("queries one pid through PowerShell under SystemRoot, never a searched name", () => {
    vi.stubEnv("SystemRoot", "D:\\Windows")
    const command = windowsProcessQueryCommand(4242)
    expect(command.command).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    expect(command.args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
    const script = Buffer.from(command.args.at(-1)!, "base64").toString("utf16le")
    expect(script).toContain("Win32_Process -Filter 'ProcessId = 4242'")
    expect(script).toContain("Win32_Process -Filter 'ProcessId = 4'")
    expect(script).toContain("ToFileTimeUtc()")
    for (const pid of [0, -1, 1.5, Number.NaN, 2 ** 31]) expect(() => windowsProcessQueryCommand(pid)).toThrow()
  })

  it("identifies a process by pid, creation time and boot", () => {
    const query = vi.fn(() => ({ boot, start }))
    expect(windowsProcessIdentity(4242, query)).toEqual({ pid: 4242, start, bootId: windowsBootId(boot) })
    expect(query).toHaveBeenCalledWith(4242)
  })

  it("names a process that is gone before its creation time was read", () => {
    expect(() => windowsProcessIdentity(4242, () => ({ boot, start: null }))).toThrow(ProcessExitedBeforeIdentityError)
  })

  it("counts a process alive only while its pid exists with the recorded creation time", () => {
    const identity = { pid: 4242, start, bootId: windowsBootId(boot) }
    const gone = vi.fn(() => ({ boot, start }))
    expect(windowsProcessAlive(identity, gone, () => false)).toBe(false)
    expect(gone).not.toHaveBeenCalled()
    expect(windowsProcessAlive(identity, () => ({ boot, start }), () => true)).toBe(true)
    // A reused pid has another creation time; an exited one has none.
    expect(windowsProcessAlive(identity, () => ({ boot, start: "134042000999999990" }), () => true)).toBe(false)
    expect(windowsProcessAlive(identity, () => ({ boot, start: null }), () => true)).toBe(false)
    // The creation time is absolute, so a different boot answer cannot make a
    // live process read as dead.
    expect(windowsProcessAlive(identity, () => ({ boot: "134041896000000010", start }), () => true)).toBe(true)
  })

  it("propagates a failed query rather than reading it as a dead process", () => {
    const failure = new Error("PowerShell could not start")
    expect(() => windowsProcessAlive({ pid: 4242, start, bootId: windowsBootId(boot) }, () => { throw failure }, () => true)).toThrow(failure)
  })

  it("ends a Windows child's whole process tree on stop", async () => {
    const treeKill = vi.fn(async (pid: number) => { process.kill(pid, "SIGKILL") })
    const launched = await launchGuestChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      // The creation time read again before the kill names this child (F2).
      platform: "win32", treeKill, alive: () => true, identify: (pid) => ({ pid, start: "123", bootId: randomUUID() }),
    })
    if (launched.state !== "started") throw new Error("child did not start")
    const exited = await launched.child.stop()
    expect(treeKill).toHaveBeenCalledWith(launched.child.identity.pid)
    expect(exited.code !== null || exited.signal !== null).toBe(true)
  })

  it("records a child that exited before its identity was read as a failed launch, after it is gone", async () => {
    const launched = await launchGuestChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      ...withoutTaskkill, identify: () => { throw new ProcessExitedBeforeIdentityError() },
    })
    expect(launched).toEqual({ state: "failed", errorCode: "EXITED_BEFORE_IDENTITY" })
  })
})

// Ruling Q296 (2026-10-01, applying Q111 B): a Windows daemon's exit is not
// its process tree's. Only a tree kill that succeeded counts; a failed one, a
// direct kill of the daemon, or an exit already observed leaves the tree
// unconfirmed, and the stop says so instead of resolving. No test runs a
// real taskkill or PowerShell: both are injected.
describe("Windows process tree shutdown", () => {
  const known = (pid: number) => ({ pid, start: "123", bootId: randomUUID() })
  const live = ["-e", "setInterval(() => {}, 1000)"]
  async function started(args: string[], options: Parameters<typeof launchGuestChild>[2]) {
    const launched = await launchGuestChild(process.execPath, args, { platform: "win32", identify: known, ...options })
    if (launched.state !== "started") throw new Error("child did not start")
    return launched.child
  }

  it("does not count a stop as tree shutdown when the tree kill is rejected", async () => {
    const child = await started(live, { alive: () => true, treeKill: async () => { throw new Error("taskkill exited with status 1") } })
    const stopped = child.stop()
    await expect(stopped).rejects.toBeInstanceOf(ProcessTreeUnconfirmedError)
    await expect(stopped).rejects.toThrow("taskkill exited with status 1")
    // The daemon itself is still ended, through Node's own handle to it.
    expect(await child.exited).toMatchObject({ signal: "SIGKILL" })
  })

  it("does not count an already observed daemon exit as tree shutdown", async () => {
    const treeKill = vi.fn(async () => {})
    const child = await started(["-e", "setTimeout(() => process.exit(0), 50)"], { alive: () => false, treeKill })
    await child.exited
    await expect(child.stop()).rejects.toBeInstanceOf(ProcessTreeUnconfirmedError)
    await expect(child.confirmTree!()).rejects.toBeInstanceOf(ProcessTreeUnconfirmedError)
    // A pid whose process has exited may already name another one.
    expect(treeKill).not.toHaveBeenCalled()
  })

  it("confirms the tree only after a tree kill that succeeded", async () => {
    const treeKill = vi.fn(async (pid: number) => { process.kill(pid, "SIGKILL") })
    const child = await started(live, { alive: () => true, treeKill })
    await expect(child.stop()).resolves.toMatchObject({ signal: "SIGKILL" })
    expect(treeKill).toHaveBeenCalledWith(child.identity.pid)
    await expect(child.confirmTree!()).resolves.toBeUndefined()
  })

  // Review F2: taskkill names the daemon by pid only. Its recorded creation
  // time is read again right before, and a pid that no longer names it, or
  // whose creation time cannot be read, is not killed by pid at all.
  it("reads the creation time again right before the tree kill", async () => {
    const order: string[] = []
    const child = await started(live, {
      alive: () => { order.push("alive"); return true },
      treeKill: async (pid) => { order.push("treeKill"); process.kill(pid, "SIGKILL") },
    })
    order.length = 0
    await child.stop()
    expect(order).toEqual(["alive", "treeKill"])
  })

  it.each([
    { name: "another creation time", alive: () => false, reason: "the daemon's pid no longer names the process this loop started" },
    { name: "an unreadable creation time", alive: () => { throw new Error("PowerShell could not start") }, reason: "PowerShell could not start" },
  ])("kills no tree by pid with $name, and says the tree is unconfirmed", async ({ alive, reason }) => {
    const treeKill = vi.fn(async () => {})
    const child = await started(live, { alive, treeKill })
    const stopped = child.stop()
    await expect(stopped).rejects.toBeInstanceOf(ProcessTreeUnconfirmedError)
    await expect(stopped).rejects.toThrow(reason)
    expect(treeKill).not.toHaveBeenCalled()
    expect(await child.exited).toMatchObject({ signal: "SIGKILL" })
  })

  it("marks a daemon that exited before its identity as an unconfirmed tree", async () => {
    const launched = await launchGuestChild(process.execPath, live, {
      platform: "win32", ...withoutTaskkill, identify: () => { throw new ProcessExitedBeforeIdentityError() },
    })
    expect(launched).toEqual({ state: "failed", errorCode: "EXITED_BEFORE_IDENTITY", treeUnconfirmed: true })
  })
})
