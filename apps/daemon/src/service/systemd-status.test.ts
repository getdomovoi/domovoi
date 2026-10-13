import { expect, it, vi } from "vitest"
import { serviceStatus } from "./install.js"

function read(stdout: string, code = 0) {
  const capture = vi.fn(async () => ({ code, stdout, stderr: "manager failed" }))
  const result = serviceStatus({ platform: "linux", home: "/home/test" }, {
    capture, exists: async () => true, claimServiceOperation: () => ({ release() {} }),
  })
  return { result, capture }
}

it("reads running systemd facts with one bounded, explicitly selected show call", async () => {
  const { result, capture } = read("ActiveState=active\nMainPID=4321\nExecMainStartTimestamp=Mon 2026-10-12 12:00:00 UTC\nNRestarts=7\nExecMainCode=0\nExecMainStatus=0\n")
  expect(await result).toEqual({ installed: true, running: true, detail: "/home/test/.config/systemd/user/domovoid.service is active",
    pid: 4321, startedAt: "2026-10-12T12:00:00.000Z", restartCount: 7 })
  expect(capture).toHaveBeenCalledExactlyOnceWith("systemctl", ["--user", "show", "domovoid.service",
    "--property=ActiveState", "--property=MainPID", "--property=ExecMainStartTimestamp", "--property=NRestarts", "--property=ExecMainCode", "--property=ExecMainStatus"], expect.objectContaining({ signal: expect.any(AbortSignal) }))
})

it.each(["active", "reloading", "refreshing", "inactive", "failed", "activating", "deactivating", "maintenance"])("preserves is-active semantics for %s", async (state) => {
  expect(await read(`ActiveState=${state}\n`).result).toMatchObject({ installed: true, running: ["active", "reloading", "refreshing"].includes(state) })
})

it("reports a stopped exit without stale process metrics", async () => {
  const status = await read("ActiveState=failed\nMainPID=4321\nExecMainStartTimestamp=Mon 2026-10-12 12:00:00 UTC\nNRestarts=7\nExecMainCode=1\nExecMainStatus=9\n").result
  expect(status).toMatchObject({ running: false, restartCount: 7, lastExit: "code 9" })
  expect(status).not.toHaveProperty("pid")
  expect(status).not.toHaveProperty("startedAt")
  expect(status).not.toHaveProperty("crashCount")
})

it("distinguishes never started from a recorded successful exit", async () => {
  const never = await read("ActiveState=inactive\nMainPID=0\nExecMainStartTimestamp=\nNRestarts=0\nExecMainCode=0\nExecMainStatus=0\n").result
  expect(never).toMatchObject({ running: false, restartCount: 0 })
  for (const key of ["pid", "startedAt", "lastExit", "crashCount"]) expect(never).not.toHaveProperty(key)
  expect(await read("ActiveState=inactive\nExecMainCode=1\nExecMainStatus=0\n").result).toHaveProperty("lastExit", "code 0")
})

it.each(["", "MainPID=\nNRestarts=\nExecMainStartTimestamp=\nExecMainCode=\nExecMainStatus=\n", "MainPID=0\nExecMainStartTimestamp=0\nExecMainCode=0\nExecMainStatus=0\n",
  "MainPID=-1\nNRestarts=-1\nExecMainStartTimestamp=n/a\nExecMainCode=2\nExecMainStatus=9\n", "MainPID=1.5\nNRestarts=1.5\nExecMainCode=1\nExecMainStatus=\n",
  "MainPID=2147483648\nNRestarts=4294967296\nExecMainStartTimestamp=Mon 2026-02-30 12:00:00 UTC\nExecMainCode=1\nExecMainStatus=256\n",
  "MainPID=4321\nMainPID=55\nNRestarts=7\nNRestarts=8\nExecMainCode=1\nExecMainCode=0\nExecMainStatus=9\n"])("keeps missing, empty, sentinel and invalid facts unknown: %j", async (properties) => {
  expect(await read(`ActiveState=active\n${properties}`).result).toEqual({ installed: true, running: true, detail: "/home/test/.config/systemd/user/domovoid.service is active" })
})

it.each(["Mon 2026-10-12 12:00:00 CST", "unfamiliar format"])("keeps state and other facts when start time is ambiguous: %s", async (stamp) => {
  const status = await read(`ActiveState=reloading\nMainPID=4321\nNRestarts=7\nExecMainStartTimestamp=${stamp}\n`).result
  expect(status).toMatchObject({ installed: true, running: true, pid: 4321, restartCount: 7 })
  expect(status).not.toHaveProperty("startedAt")
})

it.each([1, 3, 4, 127])("does not reuse is-active exit meanings for show failure %s", async (code) => {
  await expect(read("ActiveState=active\n", code).result).rejects.toThrow("manager failed")
})
