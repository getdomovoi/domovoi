import { describe, expect, it, vi } from "vitest"

import { ownDesktopDaemon, type DesktopDaemonHandle } from "./desktop-daemon.js"
import { OwnedDaemonLifecycle } from "./owned-daemon.js"

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function handle(overrides: Partial<DesktopDaemonHandle> = {}): DesktopDaemonHandle {
  return {
    authToken: "factory-token",
    start: vi.fn(async () => ({ host: "127.0.0.1", port: 47831, url: "ws://127.0.0.1:47831/rpc" })),
    stop: vi.fn(async () => {}),
    ...overrides,
  }
}

describe("ownDesktopDaemon", () => {
  it("builds exactly one daemon when callers race before the factory settles", async () => {
    const building = deferred<DesktopDaemonHandle>()
    const build = vi.fn(() => building.promise)
    const lifecycle = new OwnedDaemonLifecycle()
    const start = vi.spyOn(lifecycle, "start")
    const ensureDaemon = ownDesktopDaemon(build, lifecycle)

    const racing = [ensureDaemon(), ensureDaemon(), ensureDaemon()]
    expect(build).toHaveBeenCalledOnce()

    const daemon = handle()
    building.resolve(daemon)
    const endpoints = await Promise.all(racing)

    expect(start).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith(daemon)
    expect(daemon.start).toHaveBeenCalledOnce()
    expect(endpoints[0]).toEqual({ url: "ws://127.0.0.1:47831/rpc", token: "factory-token" })
    expect(endpoints[1]).toBe(endpoints[0])
    expect(endpoints[2]).toBe(endpoints[0])
  })

  it("answers later callers from the daemon it already built", async () => {
    const daemon = handle()
    const build = vi.fn(async () => daemon)
    const ensureDaemon = ownDesktopDaemon(build, new OwnedDaemonLifecycle())

    const first = await ensureDaemon()
    const second = await ensureDaemon()

    expect(build).toHaveBeenCalledOnce()
    expect(daemon.start).toHaveBeenCalledOnce()
    expect(second).toBe(first)
  })

  it("reports the address the listener actually claimed, not a fixed one", async () => {
    const daemon = handle({
      authToken: "file-token",
      start: vi.fn(async () => ({ host: "::1", port: 50123, url: "wss://[::1]:50123/rpc" })),
    })
    const ensureDaemon = ownDesktopDaemon(async () => daemon, new OwnedDaemonLifecycle())

    await expect(ensureDaemon()).resolves.toEqual({ url: "wss://[::1]:50123/rpc", token: "file-token" })
  })

  it("does not build a second daemon after the first failed to start", async () => {
    const conflict = Object.assign(new Error("address in use"), { code: "EADDRINUSE" })
    const daemon = handle({ start: vi.fn(async () => { throw conflict }) })
    const build = vi.fn(async () => daemon)
    const ensureDaemon = ownDesktopDaemon(build, new OwnedDaemonLifecycle())

    await expect(ensureDaemon()).rejects.toBe(conflict)
    await expect(ensureDaemon()).rejects.toBe(conflict)
    expect(build).toHaveBeenCalledOnce()
    expect(daemon.start).toHaveBeenCalledOnce()
  })

  it("hands the built daemon to the lifecycle so quitting stops it", async () => {
    const stopped = deferred<void>()
    const daemon = handle({ stop: vi.fn(() => stopped.promise) })
    const lifecycle = new OwnedDaemonLifecycle()
    const ensureDaemon = ownDesktopDaemon(async () => daemon, lifecycle)
    const quit = vi.fn()

    await ensureDaemon()
    lifecycle.beforeQuit({ preventDefault: vi.fn() }, quit)

    await vi.waitFor(() => expect(daemon.stop).toHaveBeenCalledOnce())
    expect(quit).not.toHaveBeenCalled()
    stopped.resolve()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
  })
})
