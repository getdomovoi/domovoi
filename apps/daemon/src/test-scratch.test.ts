import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { removeScratchDirectories, scratchRemovalRetries, type ScratchRemoval } from "./test-scratch.js"

async function scratch() {
  return mkdtemp(join(tmpdir(), "domovoi-scratch-"))
}

const blockedPath = join(tmpdir(), "domovoi-scratch-blocked")

// A removal refused with a code no retry can clear, which is how a removal that
// must not be retried is spelled here. It is injected rather than staged on
// disk because no directory is unremovable on every platform: a path under a
// regular file refuses with ENOTDIR on POSIX, while Windows reports it as
// missing and a forced removal of a missing path succeeds. Every other path
// still goes through the real filesystem.
function refusing(blocked: string): ScratchRemoval {
  return async (path, options) => {
    if (path !== blocked) return rm(path, options)
    throw Object.assign(new Error(`ENOTDIR: not a directory, rmdir '${path}'`), {
      code: "ENOTDIR", syscall: "rmdir", path,
    })
  }
}

describe("removeScratchDirectories", () => {
  it("removes every directory it is given", async () => {
    const first = await scratch()
    const second = await scratch()
    await writeFile(join(first, "held.txt"), "content")
    const paths = [first, second]

    await removeScratchDirectories(paths)

    await expect(stat(first)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(second)).rejects.toMatchObject({ code: "ENOENT" })
    expect(paths).toEqual([])
  })

  it("ignores a directory that is already gone", async () => {
    await expect(removeScratchDirectories([join(tmpdir(), "domovoi-scratch-missing")]))
      .resolves.toBeUndefined()
  })

  it("removes the other directories when one removal fails", async () => {
    const first = await scratch()
    const second = await scratch()

    await expect(removeScratchDirectories([first, blockedPath, second], refusing(blockedPath)))
      .rejects.toThrow()

    await expect(stat(first)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(second)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps a directory it could not remove so the next cleanup retries it", async () => {
    const removable = await scratch()
    const paths = [removable, blockedPath]

    await expect(removeScratchDirectories(paths, refusing(blockedPath))).rejects.toThrow()

    // Forgetting the path is what leaks it. Nothing leaves this list before it
    // is gone from disk, so a later cleanup still has something to remove.
    expect(paths).toEqual([blockedPath])
    await expect(stat(removable)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("retries a removal refused while something still holds the directory", async () => {
    const held = await scratch()
    const paths = [held]
    let refusals = 2
    const remove: ScratchRemoval = async (path, options) => {
      if (refusals > 0) {
        refusals -= 1
        throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`), {
          code: "ENOTEMPTY", syscall: "rmdir", path,
        })
      }
      await rm(path, options)
    }

    await removeScratchDirectories(paths, remove)

    expect(refusals).toBe(0)
    await expect(stat(held)).rejects.toMatchObject({ code: "ENOENT" })
    expect(paths).toEqual([])
  })

  it("removes a directory a stopped writer creates again", async () => {
    const home = await scratch()
    const paths = [home]
    // A provider probe the daemon started under this home can outlive the stop
    // that ended it, so a removal that resolved is not proof the tree is gone.
    let writes = 2
    const remove: ScratchRemoval = async (path, options) => {
      await rm(path, options)
      if (writes > 0) {
        writes -= 1
        await mkdir(join(home, ".config", "provider"), { recursive: true })
      }
    }

    await removeScratchDirectories(paths, remove)

    expect(writes).toBe(0)
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" })
    expect(paths).toEqual([])
  })

  it("retries removal, because Windows holds handles briefly after a test", () => {
    expect(scratchRemovalRetries).toBeGreaterThan(0)
  })
})
