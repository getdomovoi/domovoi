import { execFileSync } from "node:child_process"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { queryWindowsProcesses } from "./windows-job.js"

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
