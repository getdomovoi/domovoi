import { mkdtemp, opendir } from "node:fs/promises"
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
})
