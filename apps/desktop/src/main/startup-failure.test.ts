import { describe, expect, it, vi } from "vitest"

import { daemonErrorLogSink, recordStartupFailure } from "./startup-failure.js"

describe("recordStartupFailure", () => {
  it("appends the failure cause to the log and names the log in the dialog detail", () => {
    const append = vi.fn()
    const detail = recordStartupFailure({
      error: new Error("port 47831 is already in use"),
      logPath: "/logs/domovoi-main.log",
      append,
      now: () => new Date("2026-09-02T12:00:00.000Z"),
    })

    expect(append).toHaveBeenCalledWith(
      "/logs/domovoi-main.log",
      "2026-09-02T12:00:00.000Z startup failed: Error: port 47831 is already in use\n",
    )
    expect(detail).toBe(
      "The local daemon did not start.\n\nError: port 47831 is already in use\n\nDetails: /logs/domovoi-main.log",
    )
  })

  it("still surfaces the cause when the log itself cannot be written", () => {
    const detail = recordStartupFailure({
      error: "keychain locked",
      logPath: "/logs/domovoi-main.log",
      append: () => { throw new Error("read-only") },
    })

    expect(detail).toContain("keychain locked")
    expect(detail).toContain("/logs/domovoi-main.log")
  })
})

describe("daemonErrorLogSink", () => {
  it("appends daemon error entries with a timestamp", () => {
    const append = vi.fn()
    const sink = daemonErrorLogSink("/logs/domovoi-main.log", append)

    sink({ context: "Domovoi could not persist agent state", detail: "disk unavailable" })

    expect(append).toHaveBeenCalledTimes(1)
    const [path, text] = append.mock.calls[0] as unknown as [string, string]
    expect(path).toBe("/logs/domovoi-main.log")
    expect(text).toMatch(
      /^20[0-9-]+T[0-9:.]+Z Domovoi could not persist agent state: disk unavailable\n$/,
    )
  })

  it("swallows errors from the log destination", () => {
    const sink = daemonErrorLogSink("/logs/domovoi-main.log", () => { throw new Error("closed") })

    expect(() => sink({ context: "context", detail: "detail" })).not.toThrow()
  })
})
