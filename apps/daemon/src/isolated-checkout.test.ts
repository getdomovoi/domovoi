import { execFileSync, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { publishFileDurably } from "@getdomovoi/credential-store"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  checkOutIsolated, gitTeardownTimeoutMs, IndexChangedError, publishUnderIndexLock, runGitProcess, windowsGitStop,
} from "./isolated-checkout.js"
import { removeScratchDirectories } from "./test-scratch.js"

const scratchDirectories: string[] = []
const leftovers: number[] = []

afterEach(async () => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
  await removeScratchDirectories(scratchDirectories)
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// POSIX only: the stand-in is a shell script on PATH, and process groups are
// what the stop signals (ruling Q110 A for Windows).
const processGroups = process.platform !== "win32"

describe("runGitProcess", () => {
  // A Git whose child keeps its output pipes open after Git itself exits: the
  // close event waits on the child. A stop or a deadline still ends the
  // child's process group and settles within the teardown bound (ruling
  // Q272), so a push can never stay pending past its deadline.
  // `escapes`: the child starts a session of its own, as setsid does, so no
  // group signal reaches it; only the teardown bound settles the command.
  async function standIn(escapes = false) {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-git-standin-"))
    scratchDirectories.push(scratch)
    const bin = join(scratch, "bin")
    const pidFile = join(scratch, "child-pid")
    await mkdir(bin)
    const git = join(bin, "git")
    const escaping = [
      `"${process.execPath}" -e 'const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "inherit" });`,
      `require("node:fs").writeFileSync(process.argv[1], String(child.pid)); child.unref()' "${pidFile}"`,
    ].join(" ")
    await writeFile(git, `#!/bin/sh\n${escapes ? escaping : `sleep 60 &\necho $! > "${pidFile}"`}\nexit 0\n`)
    await chmod(git, 0o755)
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }
    const childPid = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const text = await readFile(pidFile, "utf8").catch(() => "")
        if (text.trim() !== "") return Number(text.trim())
        await new Promise((wait) => setTimeout(wait, 25))
      }
      throw new Error("The stand-in never started its child")
    }
    return { scratch, env, childPid }
  }

  it.skipIf(!processGroups).each([
    ["a caller's stop", (controller: AbortController) => () => controller.abort(new Error("stopped"))],
    ["a deadline", () => undefined],
  ] as const)("ends a child that outlives Git and holds its pipes, on %s", async (label, stopper) => {
    const { scratch, env, childPid } = await standIn()
    const controller = new AbortController()
    const signal = label === "a deadline" ? AbortSignal.timeout(500) : controller.signal
    const started = Date.now()
    const running = runGitProcess(["push"], { env, cwd: scratch, signal })
    const outcome = running.then(() => undefined, (error: unknown) => error)
    const child = await childPid()
    leftovers.push(child)
    // Git itself has exited; only its child holds the pipes now.
    for (let attempt = 0; attempt < 200 && running.child.exitCode === null; attempt += 1) await new Promise((wait) => setTimeout(wait, 25))
    expect(running.child.exitCode).toBe(0)
    stopper(controller)?.()

    expect(await outcome).toBeInstanceOf(Error)
    expect(Date.now() - started).toBeLessThan(15_000)
    for (let attempt = 0; attempt < 200 && alive(child); attempt += 1) await new Promise((wait) => setTimeout(wait, 25))
    expect(alive(child)).toBe(false)
  }, 30_000)

  it.skipIf(!processGroups)("settles a stopped command within the teardown bound when a child it cannot signal holds its pipes", async () => {
    const { scratch, env, childPid } = await standIn(true)
    const controller = new AbortController()
    const running = runGitProcess(["push"], { env, cwd: scratch, signal: controller.signal })
    const outcome = running.then(() => undefined, (error: unknown) => error)
    const child = await childPid()
    leftovers.push(child)
    for (let attempt = 0; attempt < 200 && running.child.exitCode === null; attempt += 1) await new Promise((wait) => setTimeout(wait, 25))
    const stopped = Date.now()
    controller.abort(new Error("stopped"))

    expect(await outcome).toMatchObject({ name: "AbortError" })
    const waited = Date.now() - stopped
    expect(waited).toBeGreaterThanOrEqual(gitTeardownTimeoutMs - 100)
    expect(waited).toBeLessThan(gitTeardownTimeoutMs + 5_000)
    // It left the group, so it is still running: this is what the restore
    // lease's "descendants unknown" covers.
    expect(alive(child)).toBe(true)
  }, 30_000)
})

// Windows has no process groups: a stop runs taskkill /T on the direct Git.
// Once that Git has been seen to exit its PID can belong to another process,
// so no taskkill runs then (ruling Q276), and a taskkill still running at the
// teardown bound is ended with its listeners gone. Runs on every platform
// with a fake Git and a fake taskkill.
describe("windowsGitStop", () => {
  const fakeGit = (state: { exitCode: number | null; signalCode: NodeJS.Signals | null }) => ({ pid: 4_242, ...state, kill: vi.fn(() => true) })
  const fakeTaskkill = () => Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null, kill: vi.fn(() => true) })

  it.each([
    ["exited", { exitCode: 0, signalCode: null }],
    ["been killed", { exitCode: null, signalCode: "SIGTERM" as const }],
  ])("runs no taskkill once Git has %s", (_label, state) => {
    const run = vi.fn(() => fakeTaskkill() as unknown as ChildProcess)
    windowsGitStop(fakeGit(state), run).stop()
    expect(run).not.toHaveBeenCalled()
  })

  it("runs one taskkill /T for a running Git, however often the stop comes", () => {
    const run = vi.fn((_command: string, _args: string[]) => fakeTaskkill() as unknown as ChildProcess)
    const stop = windowsGitStop(fakeGit({ exitCode: null, signalCode: null }), run)
    stop.stop()
    stop.stop()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![1]).toEqual(["/PID", "4242", "/T", "/F"])
  })

  it("ends a taskkill still running at the teardown bound and removes its listeners", () => {
    const taskkill = fakeTaskkill()
    const stop = windowsGitStop(fakeGit({ exitCode: null, signalCode: null }), () => taskkill as unknown as ChildProcess)
    stop.stop()
    expect(taskkill.listenerCount("exit")).toBeGreaterThan(0)

    stop.cancel()

    expect(taskkill.kill).toHaveBeenCalledOnce()
    expect(taskkill.listenerCount("exit")).toBe(0)
    // A failed kill reports an error event; nothing crashes on it.
    expect(() => taskkill.emit("error", new Error("kill failed"))).not.toThrow()
  })

  // The bound is the taskkill's own, so it holds even when Git closes and the
  // command settles first (ruling Q281).
  it("ends a taskkill still running at its own bound, with no one else asking", () => {
    vi.useFakeTimers()
    try {
      const taskkill = fakeTaskkill()
      windowsGitStop(fakeGit({ exitCode: null, signalCode: null }), () => taskkill as unknown as ChildProcess).stop()
      vi.advanceTimersByTime(gitTeardownTimeoutMs - 1)
      expect(taskkill.kill).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(taskkill.kill).toHaveBeenCalledOnce()
      expect(taskkill.listenerCount("exit")).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("leaves a taskkill that exits before its bound alone", () => {
    vi.useFakeTimers()
    try {
      const taskkill = fakeTaskkill()
      windowsGitStop(fakeGit({ exitCode: null, signalCode: null }), () => taskkill as unknown as ChildProcess).stop()
      taskkill.exitCode = 0
      taskkill.emit("exit", 0, null)
      vi.advanceTimersByTime(gitTeardownTimeoutMs)
      expect(taskkill.kill).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("leaves a taskkill that already finished alone at the bound", () => {
    const taskkill = fakeTaskkill()
    const stop = windowsGitStop(fakeGit({ exitCode: null, signalCode: null }), () => taskkill as unknown as ChildProcess)
    stop.stop()
    taskkill.exitCode = 0
    stop.cancel()
    expect(taskkill.kill).not.toHaveBeenCalled()
  })
})

// An index is published as Git writes one (ruling Q276): under its lock,
// created exclusively, and never past a lock that was already there.
describe("publishUnderIndexLock", () => {
  async function file() {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-index-publish-"))
    scratchDirectories.push(scratch)
    const path = join(scratch, "index")
    await writeFile(path, "old")
    return { scratch, path, lock: `${path}.lock` }
  }

  // Once the rename is done the lock's name is free, and another Git can take
  // it at once. A failure after the rename (the directory flush) never
  // removes that name, and says the index was published with its durability
  // unconfirmed (ruling Q281).
  it("never removes the lock's name after its rename, and reports a failed flush as unconfirmed durability", async () => {
    const { path, lock } = await file()
    const publish = async (staging: string, target: string, renamed?: () => void) => {
      await publishFileDurably(staging, target, renamed)
      await writeFile(lock, "another writer's", { flag: "wx" })
      throw new Error("directory flush failed")
    }

    const failing = publishUnderIndexLock(path, async () => Buffer.from("new"), undefined, { publish })

    await expect(failing).rejects.toThrow(`Domovoi published the index at ${path}, but could not confirm it is durable: directory flush failed`)
    expect(await readFile(path, "utf8")).toBe("new")
    expect(await readFile(lock, "utf8")).toBe("another writer's")
  })

  // The file at the index path proves nothing about the rename: another Git
  // can replace the index between the rename and the failed flush. The
  // publish step itself says when the rename is done (ruling Q295), and the
  // lock's name is never removed after that.
  it("keeps another writer's lock when that writer replaced the index between the rename and a failed flush", async () => {
    const { path, lock } = await file()
    const publish = async (staging: string, target: string, renamed?: () => void) => {
      await publishFileDurably(staging, target, renamed)
      await writeFile(`${path}.other`, "another writer's index")
      await publishFileDurably(`${path}.other`, path)
      await writeFile(lock, "another writer's", { flag: "wx" })
      throw new Error("directory flush failed")
    }

    const failing = publishUnderIndexLock(path, async () => Buffer.from("new"), undefined, { publish })

    await expect(failing).rejects.toThrow(`Domovoi published the index at ${path}, but could not confirm it is durable`)
    expect(await readFile(lock, "utf8")).toBe("another writer's")
  })

  // A failed rename is known not to have happened: only then is the lock
  // still this function's to remove.
  it("removes its own lock when the rename itself fails", async () => {
    const { path, lock } = await file()
    const publish = async () => { throw new Error("rename failed") }
    await expect(publishUnderIndexLock(path, async () => Buffer.from("new"), undefined, { publish })).rejects.toThrow("rename failed")
    await expect(lstat(lock)).rejects.toThrow()
    expect(await readFile(path, "utf8")).toBe("old")
  })

  // Removing its own lock is flushed through the directory too, so a power
  // loss cannot bring an empty lock back; a failed flush is reported.
  it.each([
    ["the check under the lock declines", async (): Promise<boolean> => false, async (): Promise<Buffer> => Buffer.from("new")],
    ["writing fails", async (): Promise<boolean> => true, async (): Promise<Buffer> => { throw new Error("read failed") }],
  ] as const)("flushes the directory after removing its own lock when %s", async (_label, proceed, bytes) => {
    const { scratch, path, lock } = await file()
    const flushed: string[] = []
    const syncDirectory = async (directory: string) => {
      await expect(lstat(lock)).rejects.toThrow()
      flushed.push(directory)
    }
    await publishUnderIndexLock(path, bytes, proceed, { syncDirectory }).catch(() => undefined)
    expect(flushed).toEqual([scratch])
  })

  it("reports a failed flush after removing its own lock", async () => {
    const { path } = await file()
    const syncDirectory = async () => { throw new Error("flush failed") }
    await expect(publishUnderIndexLock(path, async () => Buffer.from("new"), async () => false, { syncDirectory })).rejects.toThrow("flush failed")
  })

  it("publishes the bytes through its own lock and leaves no lock", async () => {
    const { path, lock } = await file()
    expect(await publishUnderIndexLock(path, async () => Buffer.from("new"))).toBe("published")
    expect(await readFile(path, "utf8")).toBe("new")
    await expect(lstat(lock)).rejects.toThrow()
  })

  it("leaves the file and a lock already there untouched", async () => {
    const { path, lock } = await file()
    await writeFile(lock, "someone else's")
    expect(await publishUnderIndexLock(path, async () => Buffer.from("new"))).toBe("locked")
    expect(await readFile(path, "utf8")).toBe("old")
    expect(await readFile(lock, "utf8")).toBe("someone else's")
  })

  it("changes nothing, and removes its own lock, when the check under the lock declines", async () => {
    const { path, lock } = await file()
    expect(await publishUnderIndexLock(path, async () => Buffer.from("new"), async () => false)).toBe("declined")
    expect(await readFile(path, "utf8")).toBe("old")
    await expect(lstat(lock)).rejects.toThrow()
  })

  it("removes its own lock and passes the failure on when writing fails", async () => {
    const { path, lock } = await file()
    await expect(publishUnderIndexLock(path, async () => { throw new Error("read failed") })).rejects.toThrow("read failed")
    expect(await readFile(path, "utf8")).toBe("old")
    await expect(lstat(lock)).rejects.toThrow()
  })

  // POSIX: an open file cannot be swapped for a directory on Windows.
  it.skipIf(process.platform === "win32")("names its own lock beside the failure when it cannot remove it", async () => {
    const { path, lock } = await file()
    const failing = publishUnderIndexLock(path, async () => {
      await rm(lock)
      await mkdir(lock)
      await writeFile(join(lock, "held"), "")
      throw new Error("read failed")
    })
    await expect(failing).rejects.toThrow(`read failed. Domovoi could not remove its own index lock at ${lock}`)
    expect(await readFile(path, "utf8")).toBe("old")
  })
})

// A new worktree whose index another Git wrote is kept for recovery
// (ruling Q281). A cleanup that fails afterwards, removing the checkout's own
// lock or its isolated directory, must not turn that into a failure the
// caller cleans up by removing the worktree (ruling Q295).
describe("checkOutIsolated after the index changed", () => {
  async function addedWorktree() {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-checkout-kept-"))
    scratchDirectories.push(scratch)
    const repository = join(scratch, "project")
    const worktree = join(scratch, "worktree")
    const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe" })
    git("init", "-q", "--initial-branch=main", repository)
    await writeFile(join(repository, "base.txt"), "base\n")
    git("-C", repository, "add", ".")
    git("-C", repository, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial")
    const commit = git("-C", repository, "rev-parse", "HEAD").trim()
    git("-C", repository, "worktree", "add", "-q", "--no-checkout", "-b", "domovoi/kept", worktree, commit)
    // Another Git wrote the new worktree's index after it was added.
    await writeFile(join(worktree, "late.txt"), "late\n")
    git("-C", worktree, "add", "late.txt")
    const index = join(repository, ".git", "worktrees", "worktree", "index")
    return { repository, worktree, commit, index }
  }

  it("keeps the changed-index decision when removing its own lock is not flushed", async () => {
    const { worktree, commit, index } = await addedWorktree()
    const before = await readFile(index)

    const error = await checkOutIsolated({
      worktree, commit, settings: [], initialIndex: undefined,
      indexIo: { syncDirectory: async () => { throw new Error("flush failed") } },
    }).then(() => undefined, (failure: unknown) => failure)

    expect(error).toBeInstanceOf(IndexChangedError)
    expect((error as Error).message).toContain("flush failed")
    expect((await readFile(index)).equals(before)).toBe(true)
  })

  // POSIX, not as root: a read-only Git directory makes removing the isolated
  // directory in it fail.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps the changed-index decision when its isolated directory cannot be removed", async () => {
    const { repository, worktree, commit, index } = await addedWorktree()
    const before = await readFile(index)
    const commonDirectory = join(repository, ".git")
    let locked = false
    try {
      const error = await checkOutIsolated({
        worktree, commit, settings: [], initialIndex: undefined,
        beforeCommand: () => {
          if (locked) return
          locked = true
          execFileSync("chmod", ["a-w", commonDirectory])
        },
      }).then(() => undefined, (failure: unknown) => failure)

      expect(error).toBeInstanceOf(IndexChangedError)
      expect((error as Error).message).toContain("could not remove")
    } finally {
      await chmod(commonDirectory, 0o755)
    }
    expect((await readFile(index)).equals(before)).toBe(true)
  })
})
