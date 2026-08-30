import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { ArtifactWatcher, type ArtifactFileChange, type ArtifactWatchFactory } from "./artifact-watcher.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function scratch(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `${name}-`))
  scratchDirectories.push(path)
  return path
}

describe("ArtifactWatcher", () => {
  it("describes only recognized design-studio variants", async () => {
    const root = await scratch("domovoi-artifact-variants")
    await mkdir(join(root, "design-studio", "onboarding"), { recursive: true })
    const changes: ArtifactFileChange[] = []
    const watcher = new ArtifactWatcher({ root, onChange: (change) => changes.push(change), watchFactory: () => ({ close: vi.fn() }) })
    await watcher.start()
    await writeFile(join(root, "design-studio", "onboarding", "variant-b.html"), "<h1>B</h1>")
    await writeFile(join(root, "design-studio", "onboarding", "variant-0.html"), "<h1>Zero</h1>")
    await writeFile(join(root, "design-studio", "onboarding", "variant-2.html"), "<h1>Two</h1>")
    await writeFile(join(root, "design-studio", "onboarding", "variant-999999999999999999999999.html"), "<h1>Overflow</h1>")
    await writeFile(join(root, "design-studio", "onboarding", "overview.html"), "<h1>Overview</h1>")
    await watcher.rescan()
    expect(changes.find((change) => change.path.endsWith("variant-b.html"))?.variant).toEqual({
      id: "b", groupId: "design-studio/onboarding", label: "Variant B", order: 1,
    })
    expect(changes.find((change) => change.path.endsWith("variant-0.html"))?.variant).toEqual({
      id: "0", groupId: "design-studio/onboarding", label: "Variant 0", order: 0,
    })
    expect(changes.find((change) => change.path.endsWith("variant-2.html"))?.variant?.order).toBe(2)
    expect(changes.find((change) => change.path.endsWith("variant-999999999999999999999999.html"))?.variant).toBeUndefined()
    expect(changes.find((change) => change.path.endsWith("overview.html"))?.variant).toBeUndefined()
  })
  it("emits only new and changed plan or design artifacts", async () => {
    const root = await scratch("domovoi-artifact-watcher")
    await writeFile(join(root, "existing-plan.md"), "# Existing")
    const changes: ArtifactFileChange[] = []
    const close = vi.fn()
    const watchFactory: ArtifactWatchFactory = vi.fn(() => ({ close }))
    const watcher = new ArtifactWatcher({ root, onChange: (change) => changes.push(change), watchFactory })

    await watcher.start()
    expect(changes).toEqual([])

    await writeFile(join(root, "plan-preview.html"), "<h1>Plan</h1>")
    await writeFile(join(root, "ROADMAP.html"), "<h1>Roadmap</h1>")
    await writeFile(join(root, "design-notes.md"), "# Variant A")
    await writeFile(join(root, "index.html"), "<main>Application code</main>")
    await writeFile(join(root, "README.md"), "# Repository")
    await writeFile(join(root, "design.ts"), "export const design = true")
    await watcher.rescan()

    expect(changes).toEqual([
      {
        path: "design-notes.md",
        title: "design-notes.md",
        type: "plan",
        mimeType: "text/markdown",
        content: "# Variant A",
      },
      {
        path: "plan-preview.html",
        title: "plan-preview.html",
        type: "preview",
        mimeType: "text/html",
      },
      {
        path: "ROADMAP.html",
        title: "ROADMAP.html",
        type: "preview",
        mimeType: "text/html",
      },
    ])

    await writeFile(join(root, "design-notes.md"), "# Variant B")
    await watcher.rescan()
    expect(changes.at(-1)).toMatchObject({ path: "design-notes.md", content: "# Variant B" })

    watcher.stop()
    expect(close).toHaveBeenCalledOnce()
    await writeFile(join(root, "design-after-stop.html"), "<h1>Stopped</h1>")
    await watcher.rescan()
    expect(changes).toHaveLength(4)
  })

  it("bounds traversal, symlinks, depth, and file size", async () => {
    const root = await scratch("domovoi-artifact-bounds")
    const outside = await scratch("domovoi-artifact-outside")
    await writeFile(join(outside, "design-outside.html"), "<h1>Outside</h1>")
    await mkdir(join(root, "one", "two"), { recursive: true })
    await writeFile(join(root, "one", "two", "deep-plan.md"), "# Too deep")
    await symlink(outside, join(root, "linked-designs"), "junction")
    await writeFile(join(root, "design-large.md"), "x".repeat(65))
    const changes: ArtifactFileChange[] = []
    const watcher = new ArtifactWatcher({
      root,
      maximumDepth: 1,
      maximumFileBytes: 64,
      onChange: (change) => changes.push(change),
      watchFactory: () => ({ close: vi.fn() }),
    })

    await watcher.start()
    await writeFile(join(root, "safe-plan.md"), "# Safe")
    await watcher.rescan()

    expect(changes).toEqual([{
      path: "safe-plan.md",
      title: "safe-plan.md",
      type: "plan",
      mimeType: "text/markdown",
      content: "# Safe",
    }])
  })

  it("refuses an unbounded baseline before allocating a native watcher", async () => {
    const root = await scratch("domovoi-artifact-entry-limit")
    await writeFile(join(root, "plan-a.md"), "a")
    await writeFile(join(root, "plan-b.md"), "b")
    const watchFactory = vi.fn<ArtifactWatchFactory>(() => ({ close: vi.fn() }))
    const watcher = new ArtifactWatcher({
      root,
      maximumEntries: 1,
      onChange: vi.fn(),
      watchFactory,
    })

    await expect(watcher.start()).rejects.toThrow("baseline exceeded its entry limit")
    expect(watchFactory).not.toHaveBeenCalled()
  })
})
