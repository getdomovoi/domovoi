import { describe, expect, it } from "vitest"

import { exitCode, exitCodes, renderExitCodes } from "./exit-codes.js"

describe("exit codes", () => {
  it("is the design's table, with one added code for an unpaired client", () => {
    expect(exitCodes.map((row) => [row.code, row.name])).toEqual([
      [0, "ok"],
      [1, "internal"],
      [2, "usage"],
      [3, "daemon-unreachable"],
      [4, "not-found"],
      [5, "not-paired"],
      [10, "gate-waiting"],
      [11, "turn-failed"],
      [12, "refused-by-policy"],
      [21, "connection-lost"],
      [22, "stopped-unconfirmed"],
      [31, "already-decided"],
      [32, "not-permitted"],
      [33, "needs-a-person"],
      [130, "detached"],
    ])
  })

  it("never shares a code between unconfirmed and failed, nor between any two names", () => {
    const codes = exitCodes.map((row) => row.code)
    expect(new Set(codes).size).toBe(codes.length)
    expect(exitCode("stopped-unconfirmed")).not.toBe(exitCode("turn-failed"))
    expect(exitCode("connection-lost")).not.toBe(exitCode("turn-failed"))
  })

  it("renders one line per code, name first, for --help", () => {
    const text = renderExitCodes()
    expect(text).toMatch(/^ {2}3 {2}daemon-unreachable +Could not reach the daemon before doing anything\. Nothing was sent\.$/m)
    expect(text).toMatch(/^ {2}5 {2}not-paired +No credential is stored for that daemon\. Nothing was sent\.$/m)
    expect(text).toMatch(/^130 {2}detached +Ctrl-C in watch\./m)
    expect(text.split("\n").filter((line) => line.length > 0)).toHaveLength(exitCodes.length)
  })
})
