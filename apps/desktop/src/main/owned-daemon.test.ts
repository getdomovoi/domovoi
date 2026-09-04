import { describe, expect, it, vi } from "vitest"

import { OwnedDaemonLifecycle, startDesktop } from "./owned-daemon.js"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe("startDesktop", () => {
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

describe("OwnedDaemonLifecycle", () => {
  it("refuses to adopt a listener it did not start", async () => {
    const conflict = Object.assign(new Error("address in use"), { code: "EADDRINUSE" })
    const daemon = { start: vi.fn(async () => { throw conflict }), stop: vi.fn(async () => {}) }

    await expect(new OwnedDaemonLifecycle().start(daemon)).rejects.toBe(conflict)
  })

  it("returns the address the daemon claimed", async () => {
    const address = { host: "127.0.0.1", port: 47831, url: "ws://127.0.0.1:47831/rpc" }
    const daemon = { start: vi.fn(async () => address), stop: vi.fn(async () => {}) }

    await expect(new OwnedDaemonLifecycle().start(daemon)).resolves.toBe(address)
  })

  it("waits for the owned daemon to stop before allowing a normal quit", async () => {
    const stopped = deferred()
    const daemon = {
      start: vi.fn(async () => ({ host: "127.0.0.1", port: 47831 })),
      stop: vi.fn(() => stopped.promise),
    }
    const lifecycle = new OwnedDaemonLifecycle()
    const quit = vi.fn()
    const event = { preventDefault: vi.fn() }

    await lifecycle.start(daemon)
    lifecycle.beforeQuit(event, quit)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(daemon.stop).toHaveBeenCalledOnce())
    expect(quit).not.toHaveBeenCalled()

    stopped.resolve()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())

    const finalEvent = { preventDefault: vi.fn() }
    lifecycle.beforeQuit(finalEvent, quit)
    expect(finalEvent.preventDefault).not.toHaveBeenCalled()
    expect(quit).toHaveBeenCalledOnce()
  })

  it("waits for daemon startup before stopping on quit", async () => {
    const started = deferred()
    const daemon = {
      start: vi.fn(() => started.promise),
      stop: vi.fn(async () => {}),
    }
    const lifecycle = new OwnedDaemonLifecycle()
    const quit = vi.fn()
    const starting = lifecycle.start(daemon)

    lifecycle.beforeQuit({ preventDefault: vi.fn() }, quit)
    expect(daemon.stop).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()

    started.resolve()
    await starting
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(daemon.stop).toHaveBeenCalledOnce()
  })

  it("deduplicates repeated quit requests while daemon stop is pending", async () => {
    const stopped = deferred()
    const daemon = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(() => stopped.promise),
    }
    const lifecycle = new OwnedDaemonLifecycle()
    const quit = vi.fn()
    const firstEvent = { preventDefault: vi.fn() }
    const repeatedEvent = { preventDefault: vi.fn() }

    await lifecycle.start(daemon)
    lifecycle.beforeQuit(firstEvent, quit)
    lifecycle.beforeQuit(repeatedEvent, quit)

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(daemon.stop).toHaveBeenCalledOnce())
    expect(quit).not.toHaveBeenCalled()

    stopped.resolve()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(daemon.stop).toHaveBeenCalledOnce()
  })

  it("reports a stop failure once and still permits one re-entrant quit", async () => {
    const stopFailure = new Error("daemon stop failed")
    const daemon = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => { throw stopFailure }),
    }
    const errorSink = vi.fn()
    const lifecycle = new OwnedDaemonLifecycle(errorSink)
    const reentrantEvent = { preventDefault: vi.fn() }
    const quit = vi.fn(() => lifecycle.beforeQuit(reentrantEvent, quit))

    await lifecycle.start(daemon)
    lifecycle.beforeQuit({ preventDefault: vi.fn() }, quit)
    lifecycle.beforeQuit({ preventDefault: vi.fn() }, quit)

    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    lifecycle.beforeQuit({ preventDefault: vi.fn() }, quit)

    expect(daemon.stop).toHaveBeenCalledOnce()
    expect(errorSink).toHaveBeenCalledOnce()
    expect(errorSink).toHaveBeenCalledWith(stopFailure)
    expect(quit).toHaveBeenCalledOnce()
    expect(reentrantEvent.preventDefault).not.toHaveBeenCalled()
  })

  it("stops waiting for a daemon whose stop never settles", async () => {
    const daemon = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(() => new Promise<void>(() => {})),
    }
    const lifecycle = new OwnedDaemonLifecycle(() => {}, 25)
    const quit = vi.fn()

    await lifecycle.start(daemon)
    lifecycle.beforeQuit({ preventDefault: vi.fn() }, quit)

    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(daemon.stop).toHaveBeenCalledOnce()
  })
})
