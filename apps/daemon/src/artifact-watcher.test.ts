import { mkdtemp, mkdir, opendir, symlink, writeFile } from "node:fs/promises"
import { removeScratchDirectories } from "./test-scratch.js"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { ArtifactWatcher, type ArtifactFileChange, type ArtifactWatchFactory } from "./artifact-watcher.js"

const { readFileCalls } = vi.hoisted(() => ({ readFileCalls: [] as string[] }))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    readFile: ((path: string | URL | number, options?: unknown) => {
      readFileCalls.push(String(path))
      return actual.readFile(path as never, options as never)
    }) as unknown as typeof actual.readFile,
  }
})

const scratchDirectories: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratchDirectories.splice(0))
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

  it("skips only vanished or unreadable nested directories", async () => {
    const root = await scratch("domovoi-artifact-directory-errors")
    for (const name of ["gone", "denied", "safe"]) await mkdir(join(root, name))
    const openDirectory = vi.fn<typeof opendir>(async (path, options) => {
      const name = basename(String(path))
      if (name === "gone") throw Object.assign(new Error("gone"), { code: "ENOENT" })
      if (name === "denied") throw Object.assign(new Error("denied"), { code: "EACCES" })
      return opendir(path, options)
    })
    const watcher = new ArtifactWatcher({ root, onChange: vi.fn(), openDirectory, watchFactory: () => ({ close: vi.fn() }) })
    await expect(watcher.start()).resolves.toBeUndefined()

    const brokenRoot = await scratch("domovoi-artifact-directory-eio")
    await mkdir(join(brokenRoot, "broken"))
    const broken = new ArtifactWatcher({
      root: brokenRoot,
      onChange: vi.fn(),
      watchFactory: () => ({ close: vi.fn() }),
      openDirectory: async (path, options) => {
        if (basename(String(path)) === "broken") throw Object.assign(new Error("broken"), { code: "EIO" })
        return opendir(path, options)
      },
    })
    await expect(broken.start()).rejects.toThrow("broken")
  })

  it("reads plan content only when a fingerprint changes", async () => {
    readFileCalls.length = 0
    const root = await scratch("domovoi-artifact-lazy-read")
    await writeFile(join(root, "plan-notes.md"), "# Original")
    const changes: ArtifactFileChange[] = []
    const watcher = new ArtifactWatcher({
      root,
      onChange: (change) => changes.push(change),
      watchFactory: () => ({ close: vi.fn() }),
    })

    await watcher.start()
    expect(readFileCalls).toEqual([])
    await watcher.rescan()
    expect(readFileCalls).toEqual([])
    expect(changes).toEqual([])

    await writeFile(join(root, "plan-notes.md"), "# Changed")
    await watcher.rescan()
    expect(readFileCalls).toHaveLength(1)
    expect(readFileCalls[0]).toContain("plan-notes.md")
    expect(changes).toEqual([{
      path: "plan-notes.md",
      title: "plan-notes.md",
      type: "plan",
      mimeType: "text/markdown",
      content: "# Changed",
    }])
  })

  it("does not walk build output directories", async () => {
    const root = await scratch("domovoi-artifact-build-ignored")
    for (const name of ["dist", "build", "out", "target", ".next", ".venv", "venv", "__pycache__", ".turbo", ".cache"]) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, "plan-ignored.md"), "# Ignored")
    }
    await writeFile(join(root, "plan-root.md"), "# Root")
    const changes: ArtifactFileChange[] = []
    const watcher = new ArtifactWatcher({
      root,
      maximumEntries: 20,
      onChange: (change) => changes.push(change),
      watchFactory: () => ({ close: vi.fn() }),
    })

    await expect(watcher.start()).resolves.toBeUndefined()
    await writeFile(join(root, "plan-late.md"), "# Late")
    await watcher.rescan()
    expect(changes.map((change) => change.path)).toEqual(["plan-late.md"])
  })

  it("does not install a subscription after stop during baseline", async () => {
    const root = await scratch("domovoi-artifact-stop-baseline")
    let release!: () => void
    const baseline = new Promise<void>((resolve) => { release = resolve })
    const watchFactory = vi.fn<ArtifactWatchFactory>(() => ({ close: vi.fn() }))
    const watcher = new ArtifactWatcher({
      root,
      onChange: vi.fn(),
      watchFactory,
      openDirectory: async (path, options) => {
        await baseline
        return opendir(path, options)
      },
    })
    const starting = watcher.start()
    watcher.stop()
    release()
    await starting
    expect(watchFactory).not.toHaveBeenCalled()
  })
})
