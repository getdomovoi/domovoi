import { describe, expect, it, vi } from "vitest"

import { DesktopDaemonLifecycle, startDesktop } from "./daemon-lifecycle.js"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe("startDesktop", () => {
  it("creates the window before waiting for the daemon acquisition", async () => {
    let releaseDaemon!: () => void
    const daemonAcquired = new Promise<void>((resolve) => { releaseDaemon = resolve })
    const order: string[] = []

    const starting = startDesktop(
      () => { order.push("window") },
      async () => { order.push("daemon-acquire"); await daemonAcquired },
    )

    expect(order).toEqual(["window", "daemon-acquire"])
    releaseDaemon()
    await starting
  })
})

describe("DesktopDaemonLifecycle", () => {
  it("waits for the daemon to be released before allowing a normal quit", async () => {
    const released = deferred()
    const release = vi.fn(() => released.promise)
    const lifecycle = new DesktopDaemonLifecycle(release)
    const quit = vi.fn()
    const event = { preventDefault: vi.fn() }

    lifecycle.beforeQuit(event, quit)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()

    released.resolve()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())

    const finalEvent = { preventDefault: vi.fn() }
    lifecycle.beforeQuit(finalEvent, quit)
    expect(finalEvent.preventDefault).not.toHaveBeenCalled()
    expect(quit).toHaveBeenCalledOnce()
  })

  it("deduplicates repeated quit requests while the release is pending", async () => {
    const released = deferred()
    const release = vi.fn(() => released.promise)
    const lifecycle = new DesktopDaemonLifecycle(release)
    const quit = vi.fn()
    const firstEvent = { preventDefault: vi.fn() }
    const repeatedEvent = { preventDefault: vi.fn() }

    lifecycle.beforeQuit(firstEvent, quit)
    lifecycle.beforeQuit(repeatedEvent, quit)

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()

    released.resolve()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(release).toHaveBeenCalledOnce()
  })

  it("reports a release failure once and still permits one re-entrant quit", async () => {
    const releaseFailure = new Error("daemon stop failed")
    const release = vi.fn(async () => { throw releaseFailure })
    const errorSink = vi.fn()
    const lifecycle = new DesktopDaemonLifecycle(release, errorSink)
    const reentrantEvent = { preventDefault: vi.fn() }
    const quit = vi.fn(() => lifecycle.beforeQuit(reentrantEvent, quit))

    lifecycle.beforeQuit({ preventDefault: vi.fn() }, quit)
    lifecycle.beforeQuit({ preventDefault: vi.fn() }, quit)

    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    lifecycle.beforeQuit({ preventDefault: vi.fn() }, quit)

    expect(release).toHaveBeenCalledOnce()
    expect(errorSink).toHaveBeenCalledOnce()
    expect(errorSink).toHaveBeenCalledWith(releaseFailure)
    expect(quit).toHaveBeenCalledOnce()
    expect(reentrantEvent.preventDefault).not.toHaveBeenCalled()
  })

  it("stops waiting for a release that never settles", async () => {
    const release = vi.fn(() => new Promise<void>(() => {}))
    const lifecycle = new DesktopDaemonLifecycle(release, () => {}, 25)
    const quit = vi.fn()

    lifecycle.beforeQuit({ preventDefault: vi.fn() }, quit)

    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(release).toHaveBeenCalledOnce()
  })
})
