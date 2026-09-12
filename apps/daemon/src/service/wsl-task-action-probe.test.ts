import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { OperationDeadline, OperationDeadlineExceededError } from "../operation-deadline.js"
import { captureWslTaskAction, wslTaskActionProbe } from "./wsl-task-action-probe.js"

const deadlines: OperationDeadline[] = []
afterEach(() => { for (const deadline of deadlines.splice(0)) deadline.clear() })
const deadline = (signal?: AbortSignal) => {
  const value = OperationDeadline.start(5_000, signal ? { signal } : {})
  deadlines.push(value)
  return value
}
const action = { path: "C:\\Windows\\System32\\wsl.exe", arguments: '"--exec" "/path with space/node" "a\\"b"' }
const target = {
  name: "Domovoi-WSL-test", registrationId: "08a1f2da-12e3-4b2c-9e4f-0123456789ab",
  distribution: "domovoi-ci-test", linuxUser: "root", executable: "/usr/bin/env",
  args: ["HOME=/fixture", "PATH=/opt/node/bin:/usr/bin", "/opt/node/bin/node", "--import", "/fixture/observer.mjs", "/daemon.js"],
  powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", wsl: action.path,
}
const probeInput = { runtime: "/opt/node/bin/node", environment: target.args.slice(0, 2),
  files: [{ path: process.execPath, executable: true }, { path: process.execPath + "/not-a-child", executable: false }] }

describe("WSL task launch control construction", () => {
  it("passes the actual generated program and adversarial argv through task validation", () => {
    const probe = wslTaskActionProbe(target, probeInput)
    expect(probe.script).not.toMatch(/[\r\n]/)
    expect(probe.argv.slice(1)).toEqual([...target.args, "space value", 'a"b', "tail\\", "$HOME", "$(printf domovoi-shell-expanded)"])
    expect(probe.action.arguments).toMatch(/^--distribution domovoi-ci-test --user root --exec /)
    expect(probe.action.arguments).toContain('"a\\"b" "tail\\\\"')
    expect(probe.variants.map((variant) => variant.name)).toEqual(["registered-prefix", "legacy-quoted-prefix", "quoted-prefix-values"])
    expect(probe.variants[0]?.action).toEqual(probe.action)
    expect(probe.variants[1]?.action.arguments).toMatch(/^"--distribution" "domovoi-ci-test" "--user" "root" "--exec" /)
    expect(probe.variants[2]?.action.arguments).toMatch(/^--distribution "domovoi-ci-test" --user "root" --exec /)
    for (const variant of probe.variants) expect(variant.action.arguments).toContain('"/usr/bin/env" ')
    expect(new Set(probe.variants.map((variant) => variant.action.arguments.split('"/usr/bin/env"')[1])).size).toBe(1)
  })

  it("refuses shell-sensitive fixture names before building the legacy shell-fallback control", () => {
    expect(() => wslTaskActionProbe({ ...target, distribution: "$(id)" }, probeInput)).toThrow("plain fixture prefix tokens")
  })

  it.runIf(process.platform !== "win32")("executes the generated program and preserves the observed argv and file results", async () => {
    const probe = wslTaskActionProbe(target, probeInput)
    const result = await promisify(execFile)(process.execPath, ["-e", probe.script, "--", ...probe.argv], { timeout: 5_000 })
    expect(JSON.parse(result.stdout)).toMatchObject({ executable: process.execPath, uid: process.getuid!(),
      argv: probe.argv.slice(1), files: [{ path: process.execPath, state: "accessible" },
        { path: process.execPath + "/not-a-child", state: "error", code: "ENOTDIR" }] })
  })
})

describe("WSL task action control capture", () => {
  it("passes the registered argument string verbatim and bounds captured output", async () => {
    const active = deadline()
    const captured = await captureWslTaskAction(action, active, async (file, args, options) => {
      expect(file).toBe(action.path)
      expect(args).toEqual([action.arguments])
      expect(options).toMatchObject({ windowsVerbatimArguments: true, windowsHide: true,
        maxBuffer: 65_536, encoding: "buffer", signal: active.signal, killSignal: "SIGKILL" })
      expect(options.timeout).toBeGreaterThan(0)
      expect(options.timeout).toBeLessThanOrEqual(5_000)
      return { stdout: Buffer.from("received argv"), stderr: Buffer.from("diagnostic stderr") }
    })
    expect(captured).toEqual({ code: 0, stdout: "received argv", stderr: "diagnostic stderr" })
  })

  it("records a real nonzero exit and both output streams without calling it success", async () => {
    const exited = Object.assign(new Error("Command failed"), { code: 127, signal: null, stdout: Buffer.from("out"), stderr: Buffer.from("exec failed") })
    await expect(captureWslTaskAction(action, deadline(), async () => { throw exited }))
      .resolves.toEqual({ code: 127, stdout: "out", stderr: "exec failed" })
  })

  it.each([
    { code: "ENOENT" }, { code: null, signal: "SIGTERM" }, { code: 127, signal: "SIGTERM" },
    { code: 0, signal: null }, { code: 127, signal: null, stdout: undefined },
  ])("refuses an unreadable process result rather than inventing an exit: %j", async (fields) => {
    const failure = Object.assign(new Error("Unobserved exit"), { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, fields)
    await expect(captureWslTaskAction(action, deadline(), async () => { throw failure })).rejects.toBe(failure)
  })

  it("decodes UTF-16 WSL diagnostics without requiring WSL_UTF8", async () => {
    await expect(captureWslTaskAction(action, deadline(), async () => ({
      stdout: Buffer.from('\ufeff{"user":"root"}', "utf16le"), stderr: Buffer.from("\ufefféchec", "utf16le"),
    }))).resolves.toEqual({ code: 0, stdout: '{"user":"root"}', stderr: "échec" })
  })

  it("keeps the operation deadline primary when the process does not settle", async () => {
    const abort = new AbortController()
    const active = deadline(abort.signal)
    const failure = new OperationDeadlineExceededError()
    await expect(captureWslTaskAction(action, active, async () => {
      abort.abort(failure)
      return new Promise<never>(() => {})
    })).rejects.toBe(failure)
  })
})
