import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  guestBootId, guestProcessAlive, guestProcessIdentity, launchGuestChild, parseGuestProcessStat, parseWindowsProcessAnswer,
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
// These answers are injected; the native Windows tests below read real ones.
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
      platform: "win32", treeKill, identify: (pid) => ({ pid, start: "123", bootId: randomUUID() }),
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

// Real Windows identity, on the Windows CI leg only.
it.runIf(process.platform === "win32")("identifies this process and a stopped child by real Windows creation times", async () => {
  const self = guestProcessIdentity(process.pid)
  expect(guestProcessIdentity(process.pid)).toEqual(self)
  expect(guestBootId()).toBe(self.bootId)
  expect(guestProcessAlive(self)).toBe(true)
  expect(guestProcessAlive({ ...self, start: String(BigInt(self.start) + 10n) })).toBe(false)
  const launched = await launchGuestChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], withoutTaskkill)
  if (launched.state !== "started") throw new Error("child did not start")
  expect(guestProcessAlive(launched.child.identity)).toBe(true)
  await launched.child.stop()
  expect(guestProcessAlive(launched.child.identity)).toBe(false)
}, 60_000)
