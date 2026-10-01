import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { expect, it } from "vitest"

import { launchGuestChild, parseGuestProcessStat } from "./supervisor-process.js"

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
    identify: (pid) => ({ pid, start: "123", bootId: randomUUID() }),
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
    identify: () => { throw failure },
  })).rejects.toBe(failure)
})
