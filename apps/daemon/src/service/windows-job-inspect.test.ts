import { execFileSync } from "node:child_process"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { OperationDeadline } from "../operation-deadline.js"
import { queryWindowsProcess, queryWindowsProcesses, queryWindowsJob } from "./windows-job.js"

vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFileSync: vi.fn() }))
beforeEach(() => vi.stubEnv("SystemRoot", "C:\\Windows"))
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks() })
const bootId = "windows-boot:42"
const identity = { pid: 123, start: "456", bootId }

it("gets one boot observation and birth identities for every requested PID", () => {
  const observation = { bootId, identities: [identity, null] }
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify(observation))
  expect(queryWindowsProcesses([123, 124])).toEqual(observation)
  expect(execFileSync).toHaveBeenCalledTimes(1)
  expect(execFileSync).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ input: JSON.stringify({ mode: "inspect", pids: [123, 124] }) + "\n" }))
})

it("refuses incomplete, reordered, and inconsistent birth evidence", () => {
  for (const identities of [[identity], [null, identity], [{ ...identity, bootId: "windows-boot:43" }, null]]) {
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ bootId, identities }))
    expect(() => queryWindowsProcesses([123, 124])).toThrow()
  }
  vi.mocked(execFileSync).mockImplementation(() => { throw new Error("Access denied") })
  expect(() => queryWindowsProcesses([123, 124])).toThrow("Access denied")
})

const job = "Global\\Domovoi-12345678-1234-4234-8234-123456789abc"
const queries = [
  { name: "process", run: (deadline: OperationDeadline) => queryWindowsProcess(123, deadline), output: { bootId, identities: [identity] } },
  { name: "process batch", run: (deadline: OperationDeadline) => queryWindowsProcesses([123, 124], deadline), output: { bootId, identities: [identity, null] } },
  { name: "job", run: (deadline: OperationDeadline) => queryWindowsJob(job, 123, deadline), output: { bootId, jobExists: false, identity: null } },
]

it.each(queries)("bounds $name inspection by the remaining operation budget", ({ run, output }) => {
  let now = 0
  const deadline = OperationDeadline.start(30_000, { now: () => now })
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify(output))
  try {
    run(deadline)
    expect(vi.mocked(execFileSync).mock.calls.at(-1)?.[2]?.timeout).toBe(20_000)
    now = 29_250
    run(deadline)
    expect(vi.mocked(execFileSync).mock.calls.at(-1)?.[2]?.timeout).toBe(750)
  } finally { deadline.clear() }
})

it.each(queries)("does not spawn $name inspection after expiry or cancellation", ({ run, output }) => {
  let now = 0
  const controller = new AbortController()
  const deadline = OperationDeadline.start(30_000, { now: () => now })
  const cancelled = OperationDeadline.start(30_000, { signal: controller.signal })
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify(output))
  try {
    now = 30_000
    expect(() => run(deadline)).toThrow("deadline")
    controller.abort()
    expect(() => run(cancelled)).toThrow("cancelled")
    expect(execFileSync).not.toHaveBeenCalled()
  } finally { deadline.clear(); cancelled.clear() }
})

it.each(queries)("refuses late $name evidence when the synchronous call consumes the budget", ({ run, output }) => {
  let now = 0
  const deadline = OperationDeadline.start(1000, { now: () => now })
  vi.mocked(execFileSync).mockImplementation(() => { now = 1000; return JSON.stringify(output) })
  try { expect(() => run(deadline)).toThrow("deadline") }
  finally { deadline.clear() }
})
