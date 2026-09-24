import { mkdtemp, opendir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { ArtifactWatcher, watchFactoryFor, type ArtifactWatchFactory } from "./artifact-watcher.js"
import { removeScratchDirectories } from "./test-scratch.js"

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
    await vi.waitFor(() => expect(hold).toBeDefined())
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
})
