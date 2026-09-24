import { mkdir, mkdtemp, opendir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { ArtifactWatcher, artifactIdleAfterScans, artifactIdlePollIntervalMs, artifactPollIntervalMs, watchFactoryFor, type ArtifactWatchFactory } from "./artifact-watcher.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"

const scratchDirectories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await removeScratchDirectories(scratchDirectories)
})

describe("artifact watch events", () => {
  it("does not rescan the worktree for events inside ignored directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-artifact-events-"))
    scratchDirectories.push(root)
    let emit: (path?: string) => void = () => {}
    const watchFactory: ArtifactWatchFactory = (_root, onEvent) => {
      emit = onEvent
      return { close: vi.fn() }
    }
    const openDirectory = vi.fn(opendir)
    const watcher = new ArtifactWatcher({ root, onChange: vi.fn(), watchFactory, openDirectory, debounceMs: 0 })
    await watcher.start()
    const walks = openDirectory.mock.calls.length

    emit(join("node_modules", ".vite", "deps", "chunk.js"))
    emit(join("packages", "ui", "coverage", "index.html"))
    emit(join(".git", "index"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(openDirectory.mock.calls.length).toBe(walks)

    emit(join("plans", "next-plan.md"))
    await vi.waitFor(() => expect(openDirectory.mock.calls.length).toBeGreaterThan(walks), { timeout: 1_000 })
    watcher.stop()
  })

  it("watches recursively only where the platform does it natively", () => {
    vi.useFakeTimers()
    const onEvent = vi.fn()
    const subscription = watchFactoryFor("linux")("/unused-root", onEvent, vi.fn())
    expect(onEvent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_000)
    expect(onEvent).toHaveBeenCalledTimes(1)
    subscription.close()
    vi.advanceTimersByTime(10_000)
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(watchFactoryFor("darwin")).not.toBe(watchFactoryFor("linux"))
    expect(watchFactoryFor("win32")).toBe(watchFactoryFor("darwin"))
  })

  // A poll tick or an event while a scan is still running must not queue
  // another walk per tick: a scan slower than the poll interval would grow the
  // queue without bound. At most one walk waits behind the one in flight.
  it("keeps at most one rescan waiting behind the one in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-artifact-queue-"))
    scratchDirectories.push(root)
    let hold: (() => void) | undefined
    let holding = false
    const openDirectory = vi.fn(async (path: Parameters<typeof opendir>[0]) => {
      if (holding) await new Promise<void>((resolve) => { hold = resolve })
      return opendir(path)
    })
    const watchFactory: ArtifactWatchFactory = () => ({ close: vi.fn() })
    const watcher = new ArtifactWatcher({ root, onChange: vi.fn(), watchFactory, openDirectory })
    await watcher.start()
    const walks = openDirectory.mock.calls.length

    holding = true
    const first = watcher.rescan()
    await waitForDaemon(() => expect(hold).toBeDefined())
    holding = false
    const queued = Array.from({ length: 10 }, () => watcher.rescan())
    hold!()
    await Promise.all([first, ...queued])

    expect(openDirectory.mock.calls.length - walks).toBe(2)
    watcher.stop()
  })

  // A failure that repeats on every poll is one fact, reported once, and
  // reported again only after the watcher recovered and failed anew.
  it("reports a repeating scan failure once per change of state", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-artifact-failure-"))
    scratchDirectories.push(root)
    const onError = vi.fn()
    const watchFactory: ArtifactWatchFactory = () => ({ close: vi.fn() })
    const watcher = new ArtifactWatcher({ root, onChange: vi.fn(), onError, watchFactory, maximumEntries: 1 })
    await watcher.start()

    await writeFile(join(root, "one.txt"), "1")
    await writeFile(join(root, "two.txt"), "2")
    for (let poll = 0; poll < 3; poll += 1) await watcher.rescan()
    expect(onError).toHaveBeenCalledTimes(1)

    await rm(join(root, "two.txt"))
    await watcher.rescan()
    await writeFile(join(root, "two.txt"), "2")
    await watcher.rescan()
    await watcher.rescan()
    expect(onError).toHaveBeenCalledTimes(2)
    watcher.stop()
  })

  // fetzy, 2026-09-23: after a few unchanged scans an idle session is scanned
  // every 10 s; activity snaps it back to 2 s. "A few" is three.
  // Each wait ends on the tick it is for and then waits for that tick's scan
  // itself. A count of event loop turns is not a wait for the scan: its file
  // system calls finish when the system answers them, later on a slower disk,
  // and the poll arms its next timer only once the scan is done. Every
  // directory read here is held for a few real milliseconds, so a wait that
  // does not follow the scan fails on every platform, not only a slow one.
  describe("idle backoff on the polled platforms", () => {
    async function polledWatcher() {
      const root = await mkdtemp(join(tmpdir(), "domovoi-artifact-idle-"))
      scratchDirectories.push(root)
      const realRoot = await realpath(root)
      const realSetTimeout = globalThis.setTimeout
      const openDirectory = vi.fn(async (path: Parameters<typeof opendir>[0]) => {
        await new Promise((resolve) => realSetTimeout(resolve, 5))
        return opendir(path)
      })
      const onChange = vi.fn()
      let inFlight: Promise<void> | undefined
      const polled = watchFactoryFor("linux")
      const watchFactory: ArtifactWatchFactory = (watched, onEvent, onError, poll) => polled(watched, onEvent, onError, poll && {
        delay: poll.delay,
        tick: () => (inFlight = poll.tick()),
      })
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
      const watcher = new ArtifactWatcher({ root, onChange, openDirectory, watchFactory })
      await watcher.start()
      const scans = () => openDirectory.mock.calls.filter(([path]) => path === realRoot).length
      const wait = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms)
        while (inFlight) {
          const scan = inFlight
          await scan.catch(() => undefined)
          if (inFlight === scan) inFlight = undefined
        }
        // The poll arms its next timer a few promise steps after the scan.
        await new Promise((resolve) => setImmediate(resolve))
      }
      return { root, watcher, scans, wait, onChange }
    }

    it("names the bound", () => {
      expect([artifactPollIntervalMs, artifactIdlePollIntervalMs, artifactIdleAfterScans]).toEqual([2_000, 10_000, 3])
    })

    it("scans every 2 s until three scans find nothing new, then every 10 s", async () => {
      const { watcher, scans, wait } = await polledWatcher()
      const started = scans()
      await wait(2_000)
      await wait(2_000)
      expect(scans() - started).toBe(2)
      await wait(2_000)
      await wait(2_000)
      expect(scans() - started).toBe(2)
      await wait(6_000)
      expect(scans() - started).toBe(3)
      watcher.stop()
    })

    it("goes back to 2 s once a scan finds a new artifact", async () => {
      const { root, watcher, scans, wait, onChange } = await polledWatcher()
      await wait(2_000)
      await wait(2_000)
      const idle = scans()
      await mkdir(join(root, "plans"))
      await writeFile(join(root, "plans", "next-plan.md"), "# Next")
      await wait(10_000)
      expect(onChange).toHaveBeenCalledOnce()
      const found = scans()
      expect(found - idle).toBe(1)
      await wait(2_000)
      expect(scans() - found).toBe(1)
      watcher.stop()
    })

    it("scans within 2 s of a turn starting and stays at 2 s while it runs", async () => {
      const { watcher, scans, wait } = await polledWatcher()
      await wait(2_000)
      await wait(2_000)
      const idle = scans()
      watcher.setBusy(true)
      await wait(2_000)
      expect(scans() - idle).toBe(1)
      for (let poll = 0; poll < 4; poll += 1) await wait(2_000)
      expect(scans() - idle).toBe(5)
      watcher.setBusy(false)
      await wait(2_000)
      await wait(2_000)
      await wait(2_000)
      const settled = scans()
      await wait(2_000)
      expect(scans()).toBe(settled)
      watcher.stop()
    })
  })
})
