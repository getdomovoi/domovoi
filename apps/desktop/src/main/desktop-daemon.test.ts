import type { AcquireLocalDaemonOptions, LocalDaemonHandle } from "@getdomovoi/daemon"
import { describe, expect, it, vi } from "vitest"

import { DesktopDaemon, desktopDaemonBudgets, type DesktopDaemonSeam } from "./desktop-daemon.js"

const endpoint = { url: "ws://127.0.0.1:47831/rpc", token: "file-token" }
const restarted = { url: "wss://[::1]:50123/rpc", token: "rotated-token" }
const factoryOptions = {
  environment: { DOMOVOI_PORT: "0" },
  homeDirectory: "/home/user",
  machineLabel: "workstation",
  errorSink: () => {},
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function owned(address = endpoint) {
  return { kind: "owned" as const, endpoint: address, stop: vi.fn(async () => {}) }
}

function attached(owner: "daemon" | "desktop" = "daemon", address = endpoint) {
  return { kind: "attached" as const, owner, endpoint: address, detach: vi.fn() }
}

function refused(reason: Extract<LocalDaemonHandle, { kind: "refused" }>["reason"]) {
  return { kind: "refused" as const, reason, message: `daemon says ${reason}` }
}

function scriptedSeam(handles: LocalDaemonHandle[]) {
  const requests: AcquireLocalDaemonOptions[] = []
  const seam: DesktopDaemonSeam = vi.fn(async (options) => {
    requests.push(options)
    const next = handles.shift()
    if (!next) throw new Error("No handle was scripted for this acquisition")
    return next
  })
  return { seam, requests, modes: () => requests.map((request) => request.mode) }
}

describe("DesktopDaemon", () => {
  it("acquires once with start-or-attach and shares that acquisition with racing callers", async () => {
    const acquiring = deferred<LocalDaemonHandle>()
    const seam = vi.fn(() => acquiring.promise)
    const daemon = new DesktopDaemon(seam, () => factoryOptions)

    const racing = [daemon.acquire(), daemon.acquire(), daemon.acquire()]
    expect(seam).toHaveBeenCalledOnce()
    expect(seam).toHaveBeenCalledWith({
      ...factoryOptions,
      mode: "start-or-attach",
      timeoutMs: desktopDaemonBudgets.acquireMs,
    })
    expect(Number.isFinite(desktopDaemonBudgets.acquireMs)).toBe(true)
    expect(desktopDaemonBudgets.acquireMs).toBeGreaterThan(0)

    acquiring.resolve(owned())
    const results = await Promise.all(racing)

    expect(results[0]).toEqual({ kind: "owned", url: endpoint.url, token: endpoint.token })
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])
    expect(seam).toHaveBeenCalledOnce()
  })

  it("answers later callers from the daemon it already owns", async () => {
    const { seam } = scriptedSeam([owned(restarted)])
    const daemon = new DesktopDaemon(seam, () => factoryOptions)

    await expect(daemon.acquire()).resolves.toEqual({ kind: "owned", ...restarted })
    await expect(daemon.acquire()).resolves.toEqual({ kind: "owned", ...restarted })
    await expect(daemon.reacquire()).resolves.toEqual({ kind: "owned", ...restarted })
    expect(seam).toHaveBeenCalledOnce()
  })

  it("describes an attached owner to the renderer without re-verifying on every request", async () => {
    const { seam } = scriptedSeam([attached("desktop")])
    const daemon = new DesktopDaemon(seam, () => factoryOptions)

    await expect(daemon.acquire()).resolves.toEqual({ kind: "attached", owner: "desktop", ...endpoint })
    await expect(daemon.acquire()).resolves.toEqual({ kind: "attached", owner: "desktop", ...endpoint })
    expect(seam).toHaveBeenCalledOnce()
  })

  it("describes a refusal with the daemon's reason and message", async () => {
    const { seam } = scriptedSeam([refused("profile-invalid")])
    const daemon = new DesktopDaemon(seam, () => factoryOptions)

    await expect(daemon.acquire()).resolves.toEqual({
      kind: "refused",
      reason: "profile-invalid",
      message: "daemon says profile-invalid",
    })
  })

  it("reconnects in attach-only mode and hands over the owner's fresh endpoint", async () => {
    const first = attached("daemon")
    const { seam, requests, modes } = scriptedSeam([first, attached("daemon", restarted)])
    const daemon = new DesktopDaemon(seam, () => factoryOptions)

    await daemon.acquire()
    await expect(daemon.reacquire()).resolves.toEqual({ kind: "attached", owner: "daemon", ...restarted })

    expect(modes()).toEqual(["start-or-attach", "attach-only"])
    expect(requests[1]).toEqual({ ...factoryOptions, mode: "attach-only", timeoutMs: desktopDaemonBudgets.acquireMs })
    expect(first.detach).toHaveBeenCalledOnce()
    await expect(daemon.acquire()).resolves.toEqual({ kind: "attached", owner: "daemon", ...restarted })
    expect(seam).toHaveBeenCalledTimes(2)
  })

  it("surfaces owner-unreachable on reconnect and never starts a daemon to fill the gap", async () => {
    const first = attached("daemon")
    const { seam, modes } = scriptedSeam([first, refused("owner-unreachable"), refused("owner-unreachable")])
    const daemon = new DesktopDaemon(seam, () => factoryOptions)

    await daemon.acquire()
    await expect(daemon.reacquire()).resolves.toEqual({
      kind: "refused",
      reason: "owner-unreachable",
      message: "daemon says owner-unreachable",
    })
    expect(first.detach).toHaveBeenCalledOnce()

    await expect(daemon.acquire()).resolves.toMatchObject({ kind: "refused", reason: "owner-unreachable" })
    expect(modes()).toEqual(["start-or-attach", "attach-only", "attach-only"])
    expect(seam).toHaveBeenCalledTimes(3)
  })

  it("retries a refused startup in attach-only mode rather than starting a daemon", async () => {
    const { seam, modes } = scriptedSeam([refused("owner-busy"), attached("daemon")])
    const daemon = new DesktopDaemon(seam, () => factoryOptions)

    await expect(daemon.acquire()).resolves.toMatchObject({ kind: "refused", reason: "owner-busy" })
    await expect(daemon.acquire()).resolves.toEqual({ kind: "attached", owner: "daemon", ...endpoint })
    expect(modes()).toEqual(["start-or-attach", "attach-only"])
  })

  it("shares one pending reconnect between callers", async () => {
    const reattaching = deferred<LocalDaemonHandle>()
    const first = attached("daemon")
    const seam = vi.fn<DesktopDaemonSeam>()
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(reattaching.promise)
    const daemon = new DesktopDaemon(seam, () => factoryOptions)

    await daemon.acquire()
    const racing = [daemon.reacquire(), daemon.acquire(), daemon.reacquire()]
    expect(seam).toHaveBeenCalledTimes(2)

    reattaching.resolve(attached("daemon", restarted))
    const results = await Promise.all(racing)
    expect(results).toEqual(Array(3).fill({ kind: "attached", owner: "daemon", ...restarted }))
  })

  it("does not acquire again after the seam itself failed", async () => {
    const failure = new Error("seam exploded")
    const seam = vi.fn<DesktopDaemonSeam>(async () => { throw failure })
    const daemon = new DesktopDaemon(seam, () => factoryOptions)

    await expect(daemon.acquire()).rejects.toBe(failure)
    await expect(daemon.acquire()).rejects.toBe(failure)
    await expect(daemon.reacquire()).rejects.toBe(failure)
    expect(seam).toHaveBeenCalledOnce()
  })

  it("reports the acquisition it currently holds without touching the seam", async () => {
    const { seam } = scriptedSeam([attached("daemon"), refused("owner-unreachable")])
    const daemon = new DesktopDaemon(seam, () => factoryOptions)

    expect(daemon.current()).toBeUndefined()
    await daemon.acquire()
    expect(daemon.current()).toEqual({ kind: "attached", owner: "daemon", ...endpoint })
    const reacquiring = daemon.reacquire()
    expect(daemon.current()).toEqual({ kind: "attached", owner: "daemon", ...endpoint })
    await reacquiring
    expect(daemon.current()).toEqual({ kind: "refused", reason: "owner-unreachable", message: "daemon says owner-unreachable" })
    expect(seam).toHaveBeenCalledTimes(2)
  })

  it("reads the factory options when it acquires, not when it is constructed", async () => {
    const options = vi.fn(() => factoryOptions)
    const { seam } = scriptedSeam([owned()])
    const daemon = new DesktopDaemon(seam, options)

    expect(options).not.toHaveBeenCalled()
    await daemon.acquire()
    expect(options).toHaveBeenCalledOnce()
  })

  describe("release", () => {
    it("stops an owned daemon exactly once", async () => {
      const handle = owned()
      const { seam } = scriptedSeam([handle])
      const daemon = new DesktopDaemon(seam, () => factoryOptions)

      await daemon.acquire()
      await Promise.all([daemon.release(), daemon.release()])
      await daemon.release()

      expect(handle.stop).toHaveBeenCalledOnce()
      await expect(daemon.acquire()).rejects.toThrow("Desktop is quitting")
      await expect(daemon.reacquire()).rejects.toThrow("Desktop is quitting")
      expect(seam).toHaveBeenCalledOnce()
    })

    it("detaches from an attached owner and never stops it", async () => {
      const handle = attached("daemon")
      const { seam } = scriptedSeam([handle])
      const daemon = new DesktopDaemon(seam, () => factoryOptions)

      await daemon.acquire()
      await daemon.release()
      await daemon.release()

      expect(handle.detach).toHaveBeenCalledOnce()
      expect(handle).not.toHaveProperty("stop")
    })

    it("does nothing for a refusal or when nothing was acquired", async () => {
      const { seam } = scriptedSeam([refused("owner-incompatible")])
      const daemon = new DesktopDaemon(seam, () => factoryOptions)

      await expect(new DesktopDaemon(seam, () => factoryOptions).release()).resolves.toBeUndefined()
      await daemon.acquire()
      await expect(daemon.release()).resolves.toBeUndefined()
      expect(seam).toHaveBeenCalledOnce()
    })

    it("waits for a pending acquisition before releasing what it produced", async () => {
      const acquiring = deferred<LocalDaemonHandle>()
      const seam = vi.fn(() => acquiring.promise)
      const daemon = new DesktopDaemon(seam, () => factoryOptions)
      const handle = owned()

      void daemon.acquire()
      let released = false
      const releasing = daemon.release().then(() => { released = true })
      await Promise.resolve()
      expect(released).toBe(false)
      expect(handle.stop).not.toHaveBeenCalled()

      acquiring.resolve(handle)
      await releasing
      expect(handle.stop).toHaveBeenCalledOnce()
    })

    it("releases the handle a reconnect produced, not the one it replaced", async () => {
      const first = attached("daemon")
      const second = attached("daemon", restarted)
      const { seam } = scriptedSeam([first, second])
      const daemon = new DesktopDaemon(seam, () => factoryOptions)

      await daemon.acquire()
      await daemon.reacquire()
      await daemon.release()

      expect(first.detach).toHaveBeenCalledOnce()
      expect(second.detach).toHaveBeenCalledOnce()
    })

    it("swallows a failed acquisition so quitting can proceed", async () => {
      const seam = vi.fn<DesktopDaemonSeam>(async () => { throw new Error("seam exploded") })
      const daemon = new DesktopDaemon(seam, () => factoryOptions)

      await daemon.acquire().catch(() => {})
      await expect(daemon.release()).resolves.toBeUndefined()
    })
  })
})
