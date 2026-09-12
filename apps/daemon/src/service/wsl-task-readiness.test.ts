import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { mkdir, mkdtemp, rmdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { OperationDeadline, OperationDeadlineExceededError } from "../operation-deadline.js"
import { removeScratchDirectories } from "../test-scratch.js"
import { observeWslTaskReadiness, wslGuestReadinessSnapshotScript } from "./wsl-task-test-support.js"

const directories: string[] = []
const deadlines: OperationDeadline[] = []
afterEach(async () => {
  for (const deadline of deadlines.splice(0)) deadline.clear()
  await removeScratchDirectories(directories.splice(0))
})
const lifecycle = (signal?: AbortSignal) => {
  const deadline = OperationDeadline.start(5_000, signal ? { signal } : {})
  deadlines.push(deadline)
  return deadline
}
const run = promisify(execFile)
const never = () => new Promise<never>(() => {})

describe("WSL readiness diagnostics", () => {
  it("records State and LastTaskResult for every poll, including the successful one", async () => {
    const records: Record<string, unknown>[] = []
    let polls = 0
    const value = await observeWslTaskReadiness({
      deadline: lifecycle(), diagnosticsMs: 100,
      start: async () => "domovoi-task:4",
      task: async () => ({ state: ++polls === 1 ? 3 : 4, lastTaskResult: polls === 1 ? 267011 : 0 }),
      probe: async (report) => {
        report({ step: "process-sidecar", state: polls === 1 ? "missing" : "present" })
        return polls === 2 ? "ready" : undefined
      },
      snapshot: async () => { throw new Error("No failure snapshot expected") },
      record: (entry) => records.push(entry),
    })
    expect(value).toBe("ready")
    expect(records.slice(0, 2)).toMatchObject([
      { event: "start", state: "requested" },
      { event: "start", state: "returned", result: "domovoi-task:4" },
    ])
    expect(records.filter((entry) => entry.event === "task")).toMatchObject([
      { poll: 1, state: 3, lastTaskResult: 267011 },
      { poll: 2, state: 4, lastTaskResult: 0 },
    ])
    expect(records.filter((entry) => entry.event === "guest")).toMatchObject([
      { poll: 1, step: "process-sidecar", state: "missing" },
      { poll: 2, step: "process-sidecar", state: "present" },
    ])
    expect(records.some((entry) => entry.event === "failure-diagnostics")).toBe(false)
  })

  it("uses a fresh bounded deadline for task state and sidecars after readiness expires", async () => {
    const abort = new AbortController()
    const active = lifecycle(abort.signal)
    const primary = new OperationDeadlineExceededError()
    const records: Record<string, unknown>[] = []
    const captures: OperationDeadline[] = []
    await expect(observeWslTaskReadiness({
      deadline: active, diagnosticsMs: 100,
      task: async (deadline) => {
        captures.push(deadline)
        expect(deadline.signal.aborted).toBe(false)
        return { state: 3, lastTaskResult: 2147943645 }
      },
      probe: async (report) => {
        report({ step: "owner-record", state: "reading" })
        abort.abort(primary)
        return never()
      },
      snapshot: async (deadline) => {
        captures.push(deadline)
        expect(deadline).not.toBe(active)
        expect(deadline.remainingMs()).toBeGreaterThan(0)
        return { "process.json": { state: "missing" }, ".domovoi/local-owner.json": { state: "missing" } }
      },
      record: (entry) => records.push(entry),
    })).rejects.toBe(primary)
    expect(captures).toHaveLength(3)
    expect(captures[1]).toBe(captures[2])
    expect(records.at(-1)).toMatchObject({ event: "failure-diagnostics",
      task: { value: { state: 3, lastTaskResult: 2147943645 } },
      guest: { value: { "process.json": { state: "missing" } } },
    })
    expect(records).toContainEqual(expect.objectContaining({ event: "guest", step: "owner-record", state: "reading" }))
  })

  it("keeps changing run times when separate launches return the same state and exit", async () => {
    const records: Record<string, unknown>[] = []
    const runTimes = ["2026-09-11T22:00:00.000Z", "2026-09-11T22:01:00.000Z"]
    let polls = 0
    await observeWslTaskReadiness({
      deadline: lifecycle(), diagnosticsMs: 100,
      task: async () => ({ state: 3, lastTaskResult: 127, lastRunTime: runTimes[polls++] }),
      probe: async () => polls === 2 ? "observed" : undefined,
      snapshot: async () => { throw new Error("No failure snapshot expected") },
      record: (entry) => records.push(entry),
    })
    expect(records.filter((entry) => entry.event === "task")).toMatchObject([
      { poll: 1, state: 3, lastTaskResult: 127, lastRunTime: runTimes[0] },
      { poll: 2, state: 3, lastTaskResult: 127, lastRunTime: runTimes[1] },
    ])
  })

  it("bounds a stalled diagnostic capture and keeps the readiness failure primary", async () => {
    const abort = new AbortController()
    const primary = new OperationDeadlineExceededError()
    const active = lifecycle(abort.signal)
    const records: Record<string, unknown>[] = []
    await expect(observeWslTaskReadiness({
      deadline: active, diagnosticsMs: 10,
      task: async (deadline) => deadline === active ? { state: 4, lastTaskResult: 0 } : never(),
      probe: async () => { abort.abort(primary); return never() },
      snapshot: never,
      record: (entry) => records.push(entry),
    })).rejects.toBe(primary)
    expect(records.at(-1)).toMatchObject({ event: "failure-diagnostics",
      task: { error: expect.stringContaining("deadline") }, guest: { error: expect.stringContaining("deadline") },
    })
  })

  it("still captures guest evidence when the task query itself fails", async () => {
    const primary = new Error("task State query failed")
    const records: Record<string, unknown>[] = []
    await expect(observeWslTaskReadiness({
      deadline: lifecycle(), diagnosticsMs: 100,
      task: async () => { throw primary },
      probe: async () => { throw new Error("Probe must not run") },
      snapshot: async () => ({ "process.json": { state: "present", content: "process evidence" } }),
      record: (entry) => records.push(entry),
    })).rejects.toBe(primary)
    expect(records.at(-1)).toMatchObject({ event: "failure-diagnostics",
      task: { error: "Error: task State query failed" },
      guest: { value: { "process.json": { content: "process evidence" } } },
    })
  })

  it("captures evidence if the start action fails before the first readiness poll", async () => {
    const primary = new Error("Task Run did not return")
    const records: Record<string, unknown>[] = []
    await expect(observeWslTaskReadiness({
      deadline: lifecycle(), diagnosticsMs: 100,
      start: async () => { throw primary },
      task: async () => ({ state: 2, lastTaskResult: 267011 }),
      probe: async () => { throw new Error("Probe must not run") },
      snapshot: async () => ({ "process.json": { state: "missing" } }),
      record: (entry) => records.push(entry),
    })).rejects.toBe(primary)
    expect(records[0]).toMatchObject({ event: "start", state: "requested" })
    expect(records.at(-1)).toMatchObject({ event: "failure-diagnostics",
      task: { value: { state: 2, lastTaskResult: 267011 } },
      guest: { value: { "process.json": { state: "missing" } } },
    })
  })
})

// This program runs inside the Linux guest, even when Vitest runs on Windows.
// POSIX hosts can exercise its no-follow reads directly; Windows has no such flag.
describe.runIf(typeof constants.O_NOFOLLOW === "number")("guest sidecar snapshot", () => {
  async function home() {
    const directory = await mkdtemp(join(tmpdir(), "domovoi readiness "))
    directories.push(directory)
    await mkdir(join(directory, ".domovoi"))
    return directory
  }
  async function snapshot(directory: string, setup = "") {
    const result = await run(process.execPath, ["-e", setup + "\n" + wslGuestReadinessSnapshotScript, directory], { timeout: 5_000 })
    return JSON.parse(result.stdout)
  }

  it("captures raw sidecars and distinguishes missing from unreadable files", async () => {
    const directory = await home()
    await writeFile(join(directory, "process.json"), '{"pid":42,"start":"17"}')
    await writeFile(join(directory, ".domovoi/supervisor.json"), '{"state":"exhausted"}')
    await mkdir(join(directory, ".domovoi/local-owner.json"))
    expect(await snapshot(directory)).toMatchObject({
      "process.json": { state: "present", content: '{"pid":42,"start":"17"}', truncated: false },
      "process.partial": { state: "missing" },
      ".domovoi/supervisor.json": { state: "present", content: '{"state":"exhausted"}', truncated: false },
      ".domovoi/local-owner.json": { state: "error", code: expect.any(String) },
    })
  })

  it("caps each captured sidecar at 4096 bytes and reports truncation", async () => {
    const directory = await home()
    await writeFile(join(directory, ".domovoi/local-owner.json"), "x".repeat(8192))
    const result = await snapshot(directory)
    expect(result[".domovoi/local-owner.json"]).toMatchObject({ state: "present", bytes: 4096, truncated: true })
    expect(result[".domovoi/local-owner.json"].content).toHaveLength(4096)
    expect(Object.keys(result).sort()).toEqual([".domovoi/local-owner.json", ".domovoi/supervisor.json", "process.json", "process.partial"])
  })

  it("refuses a sidecar symlink without exposing its target", async () => {
    const directory = await home()
    const outside = await home()
    await writeFile(join(outside, "private"), "outside-file-sentinel")
    await symlink(join(outside, "private"), join(directory, "process.json"))
    const result = await snapshot(directory)
    expect(result["process.json"]).toMatchObject({ state: "error", code: expect.any(String) })
    expect(JSON.stringify(result)).not.toContain("outside-file-sentinel")
  })

  it("refuses a symlinked sidecar directory without exposing its target", async () => {
    const directory = await home()
    const outside = await home()
    await writeFile(join(outside, "local-owner.json"), "outside-directory-sentinel")
    await rmdir(join(directory, ".domovoi"))
    await symlink(outside, join(directory, ".domovoi"), "junction")
    const result = await snapshot(directory)
    expect(result[".domovoi/local-owner.json"]).toMatchObject({ state: "error", code: expect.any(String) })
    expect(JSON.stringify(result)).not.toContain("outside-directory-sentinel")
  })

  it.runIf(process.platform === "linux")("refuses a parent swapped after validation using the actual opened descriptor", async () => {
    const directory = await home()
    const outside = await home()
    await writeFile(join(outside, "local-owner.json"), "outside-race-sentinel")
    const result = await snapshot(directory, [
      "{",
      "  const fs = require('node:fs'), path = require('node:path'), open = fs.openSync;",
      "  const parent = path.join(fs.realpathSync(process.argv[1]), '.domovoi');",
      "  fs.openSync = (file, ...args) => {",
      "    if (file === path.join(parent, 'local-owner.json')) {",
      "      fs.renameSync(parent, parent + '.original');",
      "      fs.symlinkSync(" + JSON.stringify(outside) + ", parent);",
      "    }",
      "    return open(file, ...args);",
      "  };",
      "}",
    ].join("\n"))
    expect(result[".domovoi/local-owner.json"]).toMatchObject({ state: "error", code: "EOUTSIDE" })
    expect(JSON.stringify(result)).not.toContain("outside-race-sentinel")
  })
})
