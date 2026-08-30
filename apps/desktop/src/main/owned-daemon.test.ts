import { describe, expect, it, vi } from "vitest"

import { startDesktop, startOwnedDaemon } from "./owned-daemon.js"

describe("startOwnedDaemon", () => {
  it("refuses to adopt a listener it did not start", async () => {
    const conflict = Object.assign(new Error("address in use"), { code: "EADDRINUSE" })
    const daemon = { start: vi.fn(async () => { throw conflict }) }

    await expect(startOwnedDaemon(daemon)).rejects.toBe(conflict)
  })

  it("returns the daemon after claiming its listener", async () => {
    const daemon = { start: vi.fn(async () => ({ host: "127.0.0.1", port: 47831 })) }

    await expect(startOwnedDaemon(daemon)).resolves.toBe(daemon)
  })

  it("creates the window before waiting for the owned daemon", async () => {
    let releaseDaemon!: () => void
    const daemonStarted = new Promise<void>((resolve) => { releaseDaemon = resolve })
    const order: string[] = []

    const starting = startDesktop(
      () => { order.push("window") },
      async () => { order.push("daemon-start"); await daemonStarted },
    )

    expect(order).toEqual(["window", "daemon-start"])
    releaseDaemon()
    await starting
  })
})
