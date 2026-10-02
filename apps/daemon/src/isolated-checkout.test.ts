import { execFileSync, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

import { publishFileDurably } from "@getdomovoi/credential-store"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  cachedGitVersions, checkOutIsolated, gitTeardownTimeoutMs, IndexChangedError, openIsolatedGit, publishUnderIndexLock, runGitProcess,
  windowsGitStop,
} from "./isolated-checkout.js"
import { repositoryFilterGate } from "./repository-git-filter-gate.js"
import { classify, readGitFilterSettings } from "./repository-git-filters.js"
import { readRepositoryProviderConfig } from "./repository-provider-config.js"
import { projectRootRead } from "./repository-trust-apply.js"
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
// so no taskkill runs then (ruling Q276). A taskkill that runs past its bound
// is a failure, as one that exits with an error is (ruling Q295). Runs on
// every platform with a fake Git and a fake taskkill.
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

  // The bound is the taskkill's own, so it holds even when Git closes and the
  // command settles first (ruling Q281). Running past it is a failed
  // taskkill: Git, if still running, is killed directly, as for any failed
  // taskkill, and the taskkill is asked to end with its completion handlers
  // kept, so its real exit or kill error is still observed (ruling Q295).
  it("kills a still-running Git directly when taskkill runs past its bound, and keeps observing taskkill", async () => {
    vi.useFakeTimers()
    try {
      const taskkill = fakeTaskkill()
      const git = fakeGit({ exitCode: null, signalCode: null })
      windowsGitStop(git, () => taskkill as unknown as ChildProcess).stop()
      await vi.advanceTimersByTimeAsync(gitTeardownTimeoutMs - 1)
      expect(taskkill.kill).not.toHaveBeenCalled()
      expect(git.kill).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)

      expect(git.kill).toHaveBeenCalledWith("SIGKILL")
      expect(taskkill.kill).toHaveBeenCalledOnce()
      expect(taskkill.listenerCount("exit")).toBeGreaterThan(0)
      expect(taskkill.listenerCount("error")).toBeGreaterThan(0)
      // A failed kill reports an error event; it is observed, not thrown.
      expect(() => taskkill.emit("error", new Error("kill failed"))).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it("kills no process directly when taskkill ends Git before its bound", async () => {
    vi.useFakeTimers()
    try {
      const taskkill = fakeTaskkill()
      const git = fakeGit({ exitCode: null, signalCode: null })
      windowsGitStop(git, () => taskkill as unknown as ChildProcess).stop()
      git.signalCode = "SIGTERM" as NodeJS.Signals | null
      taskkill.exitCode = 0
      taskkill.emit("exit", 0, null)
      await vi.advanceTimersByTimeAsync(gitTeardownTimeoutMs)
      expect(taskkill.kill).not.toHaveBeenCalled()
      expect(git.kill).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("kills Git directly when taskkill fails", async () => {
    const taskkill = fakeTaskkill()
    const git = fakeGit({ exitCode: null, signalCode: null })
    windowsGitStop(git, () => taskkill as unknown as ChildProcess).stop()
    taskkill.exitCode = 1
    taskkill.emit("exit", 1, null)
    await vi.waitFor(() => expect(git.kill).toHaveBeenCalledWith("SIGKILL"), { timeout: 1_000 })
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
      worktree, commit, initialIndex: undefined,
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
        worktree, commit, initialIndex: undefined,
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

// The isolated Git directory runs with the source worktree's effective filter
// configuration, never one it works out again (ruling Q318). Global config
// can be conditional on the Git directory or the branch, which differ there:
// every filter driver's clean, smudge, process and required are pinned to the
// source's values, and a filter key the pins do not cover refuses. Commands
// here are inert labels, read as config and never run.
describe("openIsolatedGit filter configuration", () => {
  async function sessionWorktree(global: (scratch: string) => string, local = "") {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-isolated-config-"))
    scratchDirectories.push(scratch)
    const home = join(scratch, "home")
    await mkdir(home)
    const repository = join(scratch, "project")
    const worktree = join(scratch, "worktree")
    const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe", env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") } })
    git("init", "-q", "--initial-branch=main", repository)
    await writeFile(join(repository, "base.txt"), "base\n")
    git("-C", repository, "add", ".")
    git("-C", repository, "-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial")
    git("-C", repository, "worktree", "add", "-q", "-b", "domovoi/session", worktree)
    await writeFile(join(home, ".gitconfig"), global(scratch))
    if (local !== "") {
      const config = join(repository, ".git", "config")
      await writeFile(config, `${await readFile(config, "utf8")}${local}`)
    }
    const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = join(home, ".config")
    const restore = () => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    return { scratch, worktree, repository, restore }
  }

  const isolatedValue = async (worktree: string, key: string) => {
    const isolated = await openIsolatedGit({ worktree, worktreeIndex: true })
    try {
      return (await isolated.run(["config", "--get", key])).replace(/\n$/u, "")
    } finally {
      await isolated.dispose()
    }
  }

  it("keeps a command a global branch-conditional include empties for the source branch", async () => {
    const { worktree, restore } = await sessionWorktree((scratch) => {
      const override = join(scratch, "override.gitconfig")
      execFileSync("sh", ["-c", `printf '[filter "agent"]\\n\\tclean =\\n' > "${override}"`])
      return `[filter "agent"]\n\tclean = domovoi-inert-label\n[includeIf "onbranch:domovoi/**"]\n\tpath = ${override.replaceAll("\\", "/")}\n`
    })
    try {
      expect(await isolatedValue(worktree, "filter.agent.clean")).toBe("")
    } finally {
      restore()
    }
  })

  it("keeps a repository's required=true over an inherited required=false", async () => {
    const { worktree, restore } = await sessionWorktree(
      () => "[filter \"agent\"]\n\tclean =\n\tsmudge =\n\trequired = false\n",
      "[filter \"agent\"]\n\tclean =\n\tsmudge =\n\trequired = true\n",
    )
    try {
      expect(await isolatedValue(worktree, "filter.agent.required")).toBe("true")
    } finally {
      restore()
    }
  })

  // The snapshot follows conditional includes in the worktree's context, so a
  // global include conditional on the isolated directory is never followed
  // there (ruling Q319). refuseUnpinnedFilters remains behind it.
  it("does not read a filter key only a global include conditional on the isolated directory names", async () => {
    const { worktree, restore } = await sessionWorktree((scratch) => {
      const ghost = join(scratch, "ghost.gitconfig")
      execFileSync("sh", ["-c", `printf '[filter "ghost"]\\n\\tclean = domovoi-inert-label\\n' > "${ghost}"`])
      return `[includeIf "gitdir:**/domovoi-checkout-*"]\n\tpath = ${ghost.replaceAll("\\", "/")}\n`
    })
    try {
      await expect(isolatedValue(worktree, "filter.ghost.clean")).rejects.toMatchObject({ code: 1 })
    } finally {
      restore()
    }
  })

  // GIT_CONFIG_GLOBAL, which points Git at the snapshot, came in Git 2.32:
  // an older Git would read the person's live global config instead. So
  // isolation refuses below 2.32, naming the version found (ruling Q320).
  it.each([
    ["git version 2.31.8", "2.31.8"],
    ["git version 1.9.5", "1.9.5"],
    ["not a version", undefined],
  ])("refuses to open on %j", async (version, found) => {
    const { worktree, restore } = await sessionWorktree(() => "")
    try {
      const error = await openIsolatedGit({ worktree, worktreeIndex: true, gitVersion: async () => version }).then(() => undefined, (failure: unknown) => failure)
      expect(error).toMatchObject({ name: "GitTooOldForIsolationError", message: expect.stringContaining("Git 2.32 or newer") })
      if (found !== undefined) expect((error as Error).message).toContain(found)
    } finally {
      restore()
    }
  })

  it("opens on Git 2.32.0", async () => {
    const { worktree, restore } = await sessionWorktree(() => "")
    try {
      const isolated = await openIsolatedGit({ worktree, worktreeIndex: true, gitVersion: async () => "git version 2.32.0" })
      await isolated.dispose()
    } finally {
      restore()
    }
  })

  // The Git checked is the Git that runs, by absolute path (ruling Q321): two
  // binaries selected one after the other in the same process each report
  // their own version. The first is an inert stand-in that is never run.
  it.skipIf(process.platform === "win32")("checks the version of the Git each opening selects", async () => {
    const { scratch, worktree, restore } = await sessionWorktree(() => "")
    const bin = join(scratch, "old-git-bin")
    await mkdir(bin)
    await writeFile(join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const path = process.env.PATH
    const asked: string[] = []
    const gitVersion = async (command: string) => {
      asked.push(command)
      return command === join(bin, "git") ? "git version 2.31.0" : "git version 2.54.0"
    }
    try {
      process.env.PATH = `${bin}:${path ?? ""}`
      await expect(openIsolatedGit({ worktree, worktreeIndex: true, gitVersion }))
        .rejects.toMatchObject({ name: "GitTooOldForIsolationError", message: expect.stringContaining("2.31.0") })
      process.env.PATH = path
      const isolated = await openIsolatedGit({ worktree, worktreeIndex: true, gitVersion })
      try {
        expect(await isolated.run(["config", "--get", "core.bare"])).toBe("false\n")
      } finally {
        await isolated.dispose()
      }
      expect(asked[0]).toBe(join(bin, "git"))
      expect(asked[1]).not.toBe(join(bin, "git"))
      expect(isAbsolute(asked[1]!)).toBe(true)
    } finally {
      process.env.PATH = path
      restore()
    }
  })

  it("keeps one version per Git binary path", async () => {
    const read = vi.fn(async (command: string) => command === "/old/git" ? "git version 2.31.0" : "git version 2.54.0")
    const versions = cachedGitVersions(read)
    expect(await versions("/old/git", {})).toBe("git version 2.31.0")
    expect(await versions("/new/git", {})).toBe("git version 2.54.0")
    expect(await versions("/old/git", {})).toBe("git version 2.31.0")
    expect(read.mock.calls.map(([command]) => command)).toEqual(["/old/git", "/new/git"])
  })

  // The snapshot copies Git's config bytes exactly or not at all (ruling
  // Q320): a key or value that is not valid UTF-8 refuses before isolation
  // opens, naming the key, or "a config key" when the key itself is not.
  it.each([
    ["a value", String.raw`[probe]\n\tbytes = a\377b\n`, "probe.bytes"],
    ["a subsection name", String.raw`[probe "sub\377"]\n\tbytes = plain\n`, "a config key"],
  ])("refuses a global config with %s that is not valid UTF-8", async (_label, text, named) => {
    const { worktree, restore } = await sessionWorktree((scratch) => {
      const raw = join(scratch, "raw.gitconfig")
      execFileSync("sh", ["-c", `printf '${text}' > "${raw}"`])
      return `[include]\n\tpath = ${raw.replaceAll("\\", "/")}\n`
    })
    try {
      await expect(openIsolatedGit({ worktree, worktreeIndex: true }))
        .rejects.toMatchObject({ name: "RepositoryGitConfigUnreadableError", message: expect.stringContaining(named) })
    } finally {
      restore()
    }
  })

  it("copies a value with a byte order mark and other multibyte text byte for byte", async () => {
    const { worktree, restore } = await sessionWorktree(() => "[probe \"sübsection\"]\n\tbytes = ﻿é✓\n")
    try {
      const isolated = await openIsolatedGit({ worktree, worktreeIndex: true })
      try {
        const read = await isolated.run(["config", "--get", "probe.sübsection.bytes"])
        expect(Buffer.from(read, "utf8").toString("hex")).toBe(Buffer.from("﻿é✓\n", "utf8").toString("hex"))
      } finally {
        await isolated.dispose()
      }
    } finally {
      restore()
    }
  })

  // The isolated directory reads a snapshot of the worktree's config taken
  // as it opens, never the person's live global, system or included files
  // (ruling Q319): a key written to any of them afterwards is not seen by a
  // later isolated command.
  it.each([
    ["an included global file", "included"],
    ["the global config itself", "global"],
  ] as const)("does not see a filter key added to %s after it opened", async (_label, where) => {
    let included = ""
    const { worktree, restore, scratch } = await sessionWorktree((root) => {
      included = join(root, "included.gitconfig")
      execFileSync("sh", ["-c", `: > "${included}"`])
      return `[include]\n\tpath = ${included.replaceAll("\\", "/")}\n`
    })
    try {
      const isolated = await openIsolatedGit({ worktree, worktreeIndex: true })
      try {
        const target = where === "included" ? included : join(scratch, "home", ".gitconfig")
        await writeFile(target, `${await readFile(target, "utf8")}[filter "late"]\n\tclean = domovoi-inert-label\n`)
        await expect(isolated.run(["config", "--get", "filter.late.clean"])).rejects.toMatchObject({ code: 1 })
      } finally {
        await isolated.dispose()
      }
    } finally {
      restore()
    }
  })

  // Reviewed definitions only confirm the worktree's own values (ruling
  // Q319): a reviewed command a later empty override turns off stays off.
  // Through the real gate, with a grant made over the current digests.
  const realGate = async (worktree: string, repository: string) => {
    const config = await readRepositoryProviderConfig(repository, projectRootRead)
    expect(config.gitFilters?.reviewDigest).toBeDefined()
    const grant = {
      projectId: "project-reviewed", trustedDigest: config.configDigest, trustedAt: "2026-10-01T00:00:00.000Z",
      trustedBy: { client: "desktop" as const }, gitFilterReviewDigest: config.gitFilters!.reviewDigest,
    }
    return repositoryFilterGate({
      worktree, anchor: worktree,
      trust: () => ({ projectId: "project-reviewed", projectPath: repository, grant: () => grant, generation: () => 0 }),
    })
  }

  it("does not let a reviewed command replace a later empty override", async () => {
    const { worktree, repository, restore } = await sessionWorktree(
      () => "",
      "[filter \"agent\"]\n\tclean = domovoi-inert-label\n\tclean =\n",
    )
    try {
      const gate = await realGate(worktree, repository)
      // The gate carries its effective policy: each reviewed key's last value
      // and the driver's required as Git reads it (ruling Q320).
      expect(gate).toMatchObject({ open: true, reviewed: [["filter.agent.clean", ""], ["filter.agent.required", "false"]] })
      const isolated = await openIsolatedGit({ worktree, reviewed: gate.open ? gate.reviewed : [], worktreeIndex: true })
      try {
        expect((await isolated.run(["config", "--get", "filter.agent.clean"])).replace(/\n$/u, "")).toBe("")
      } finally {
        await isolated.dispose()
      }
    } finally {
      restore()
    }
  })

  // The gate's effective policy, not the set of values it ever saw, is what
  // opening confirms (ruling Q320): a required the repository turns off after
  // the gate, or a multi-valued key whose last value changes back to an
  // earlier one, refuses, naming the key.
  it("refuses when a reviewed driver's required changes after the gate", async () => {
    const { worktree, repository, restore } = await sessionWorktree(
      () => "",
      "[filter \"agent\"]\n\tclean = domovoi-inert-label\n\trequired = true\n",
    )
    try {
      const gate = await realGate(worktree, repository)
      expect(gate).toMatchObject({ open: true, reviewed: [["filter.agent.clean", "domovoi-inert-label"], ["filter.agent.required", "true"]] })
      execFileSync("git", ["-C", repository, "config", "filter.agent.required", "false"])
      await expect(openIsolatedGit({ worktree, reviewed: gate.open ? gate.reviewed : [], worktreeIndex: true }))
        .rejects.toMatchObject({ name: "RepositoryGitConfigUnreadableError", message: expect.stringContaining("filter.agent.required") })
    } finally {
      restore()
    }
  })

  it.each([
    "filter.agent.clean",
    "lfs.extension.test.clean",
    "lfs.customtransfer.test.path",
  ])("refuses when %s goes back to an earlier reviewed value after the gate", async (key) => {
    const first = key.indexOf(".")
    const last = key.lastIndexOf(".")
    const section = `[${key.slice(0, first)} "${key.slice(first + 1, last)}"]\n`
    const variable = key.slice(last + 1)
    const { worktree, repository, restore } = await sessionWorktree(
      () => lfsLines,
      `${section}\t${variable} = domovoi-inert-first\n\t${variable} = domovoi-inert-last\n`,
    )
    try {
      const gate = await realGate(worktree, repository)
      expect(gate.open).toBe(true)
      expect(gate.open ? gate.reviewed.filter(([reviewedKey]) => reviewedKey === key) : []).toEqual([[key, "domovoi-inert-last"]])
      execFileSync("git", ["-C", repository, "config", "--replace-all", key, "domovoi-inert-first"])
      await expect(openIsolatedGit({ worktree, reviewed: gate.open ? gate.reviewed : [], worktreeIndex: true }))
        .rejects.toMatchObject({ name: "RepositoryGitConfigUnreadableError", message: expect.stringContaining(key) })
    } finally {
      restore()
    }
  })

  // Only a command or path key turns its operation off when emptied (ruling
  // Q321). A custom transfer's args is not one: emptied or removed after the
  // gate, it is a change, and the operation refuses. The path stays empty
  // throughout, so nothing could start.
  it.each([
    ["emptied", ["config", "lfs.customtransfer.test.args", ""]],
    ["removed", ["config", "--unset", "lfs.customtransfer.test.args"]],
  ])("refuses when a reviewed custom transfer's args is %s after the gate", async (_label, change) => {
    const { worktree, repository, restore } = await sessionWorktree(
      () => lfsLines,
      "[lfs \"customtransfer.test\"]\n\tpath =\n\targs = domovoi-inert-argument-label\n",
    )
    try {
      const gate = await realGate(worktree, repository)
      expect(gate).toMatchObject({ open: true, reviewed: [["lfs.customtransfer.test.args", "domovoi-inert-argument-label"]] })
      execFileSync("git", ["-C", repository, ...change])
      await expect(openIsolatedGit({ worktree, reviewed: gate.open ? gate.reviewed : [], worktreeIndex: true }))
        .rejects.toMatchObject({ name: "RepositoryGitConfigUnreadableError", message: expect.stringContaining("lfs.customtransfer.test.args") })
    } finally {
      restore()
    }
  })

  // Git LFS starts the programs its extension and custom transfer settings
  // name, reading them through `git config`. They follow the same rule as
  // filter commands (ruling Q319): the isolated directory reads each at the
  // worktree's effective value, an empty override included, and a program
  // the repository's own config names is held back unless reviewed.
  const lfsLines = "[filter \"lfs\"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n"
  it("keeps a Git LFS extension command a global branch-conditional include empties", async () => {
    const { worktree, restore } = await sessionWorktree((scratch) => {
      const override = join(scratch, "override.gitconfig")
      execFileSync("sh", ["-c", `printf '[lfs "extension.test"]\\n\\tclean =\\n' > "${override}"`])
      return `${lfsLines}[lfs "extension.test"]\n\tclean = domovoi-inert-label\n\tsmudge = domovoi-inert-label\n\tpriority = 0\n`
        + `[includeIf "onbranch:domovoi/**"]\n\tpath = ${override.replaceAll("\\", "/")}\n`
    })
    try {
      expect(await isolatedValue(worktree, "lfs.extension.test.clean")).toBe("")
    } finally {
      restore()
    }
  })

  it("keeps a repository's empty override of a global Git LFS extension command", async () => {
    const { worktree, restore } = await sessionWorktree(
      () => `${lfsLines}[lfs "extension.test"]\n\tclean = domovoi-inert-label\n\tpriority = 0\n`,
      "[lfs \"extension.test\"]\n\tclean =\n",
    )
    try {
      expect(await isolatedValue(worktree, "lfs.extension.test.clean")).toBe("")
    } finally {
      restore()
    }
  })

  // A standalone transfer agent, plain or URL-scoped, that the person's global
  // config names and the repository empties stays empty in isolation: the
  // inherited agent is in no value the directory reads (ruling Q319).
  it.each([
    ["plain", "[lfs]\n\tstandalonetransferagent = domovoi-inert-label\n", "[lfs]\n\tstandalonetransferagent =\n", "lfs.standalonetransferagent"],
    [
      "URL-scoped",
      "[lfs \"https://lfs.example.test/repo\"]\n\tstandalonetransferagent = domovoi-inert-label\n",
      "[lfs \"https://lfs.example.test/repo\"]\n\tstandalonetransferagent =\n",
      "lfs.https://lfs.example.test/repo.standalonetransferagent",
    ],
  ])("keeps a repository's empty override of a global %s standalone transfer agent", async (_label, global, local, key) => {
    const { worktree, restore } = await sessionWorktree(() => `${lfsLines}${global}`, local)
    try {
      const isolated = await openIsolatedGit({ worktree, worktreeIndex: true })
      try {
        // The snapshot and the pin each hold the worktree's value: every one
        // the directory reads is empty, and the last one wins.
        expect(await isolated.run(["config", "--get", key])).toBe("\n")
        expect((await isolated.run(["config", "--get-all", key])).split("\n").every((value) => value === "")).toBe(true)
        const all = await isolated.run(["config", "--get-regexp", "standalonetransferagent"])
        expect(all).not.toContain("domovoi-inert-label")
      } finally {
        await isolated.dispose()
      }
    } finally {
      restore()
    }
  })

  it("holds back a Git LFS extension the repository's own config names, unless reviewed", async () => {
    const { worktree, restore } = await sessionWorktree(
      () => lfsLines,
      "[lfs \"extension.evil\"]\n\tclean = domovoi-inert-label\n\tpriority = 0\n",
    )
    try {
      await expect(isolatedValue(worktree, "lfs.extension.evil.clean")).rejects.toMatchObject({ code: 1 })
    } finally {
      restore()
    }
  })

  // Git LFS takes a custom transfer's path from any key its unanchored
  // `lfs\.((?i)customtransfer\.([^.]+))\.path` matches (tq/custom.go, v3.8.0),
  // not only one that starts `lfs.customtransfer.`. Domovoi models the keys
  // that start with it and match whole; any other spelling refuses before
  // isolation opens, and before the gate lists filters (ruling Q320).
  it.each([
    ["inside an lfs subsection, overridden empty", "[lfs \"fixture.lfs.customtransfer.test\"]\n\tpath = domovoi-inert-label\n", "[lfs \"fixture.lfs.customtransfer.test\"]\n\tpath =\n", "lfs.fixture.lfs.customtransfer.test.path"],
    ["inside a filter subsection", "[filter \"lfs.customtransfer.test\"]\n\tpath = domovoi-inert-label\n", "", "filter.lfs.customtransfer.test.path"],
    ["in another section", "[probe \"lfs.CustomTransfer.test\"]\n\tpath = domovoi-inert-label\n", "", "probe.lfs.CustomTransfer.test.path"],
    ["with more after the path", "[lfs \"customtransfer.test.path\"]\n\tmore = domovoi-inert-label\n", "", "lfs.customtransfer.test.path.more"],
    ["with a longer variable name", "[lfs \"customtransfer.test\"]\n\tpathname = domovoi-inert-label\n", "", "lfs.customtransfer.test.pathname"],
  ])("refuses a Git LFS custom transfer key Domovoi does not model: %s", async (_label, global, local, key) => {
    const { worktree, restore } = await sessionWorktree(() => `${lfsLines}${global}`, local)
    try {
      await expect(isolatedValue(worktree, key))
        .rejects.toMatchObject({ name: "RepositoryGitConfigUnreadableError", message: expect.stringContaining(key) })
      await expect(readGitFilterSettings(worktree))
        .rejects.toMatchObject({ name: "RepositoryGitConfigUnreadableError", message: expect.stringContaining(key) })
    } finally {
      restore()
    }
  })

  // Git LFS reads `git config --includes -l`, splits it at every newline and
  // each line at its first "=" (git/config.go, config/git_fetcher.go, v3.8.0),
  // so a value on more than one line becomes settings Git never had. Any
  // entry whose value or key holds a line break, and a filter or Git LFS key
  // holding "=", refuses before isolation opens, naming the key (ruling Q321).
  it.each([
    ["a carried local setting", "", "[core]\n\tattributesFile = \"domovoi-inert-label\\nprobe.extra=domovoi-inert-second-label\"\n", "core.attributesfile"],
    ["an inherited global setting", "[probe]\n\tvalue = \"domovoi-inert-label\\nprobe.extra=domovoi-inert-second-label\"\n", "", "probe.value"],
  ])("refuses a multiline value in %s", async (_label, global, local, key) => {
    const { worktree, restore } = await sessionWorktree(() => global, local)
    try {
      await expect(openIsolatedGit({ worktree, worktreeIndex: true }))
        .rejects.toMatchObject({ name: "RepositoryGitConfigUnreadableError", message: expect.stringContaining(`${key} in`) })
    } finally {
      restore()
    }
  })

  it.each([
    ["a multiline filter command", "[filter \"agent\"]\n\tclean = \"domovoi-inert-label\\nprobe.extra=domovoi-inert-second-label\"\n", "filter.agent.clean"],
    ["an \"=\" in a Git LFS key", "[lfs \"extension.test.clean=probe\"]\n\tlabel = domovoi-inert-label\n", "lfs.extension.test.clean=probe.label"],
  ])("refuses %s in the gate's read and before opening", async (_label, local, key) => {
    const { worktree, restore } = await sessionWorktree(() => "", local)
    try {
      await expect(readGitFilterSettings(worktree))
        .rejects.toMatchObject({ name: "RepositoryGitConfigUnreadableError", message: expect.stringContaining(key) })
      await expect(openIsolatedGit({ worktree, worktreeIndex: true }))
        .rejects.toMatchObject({ name: "RepositoryGitConfigUnreadableError", message: expect.stringContaining(key) })
    } finally {
      restore()
    }
  })

  it("lists a custom transfer path written in mixed case as Git LFS reads it", async () => {
    const { worktree, restore } = await sessionWorktree(() => lfsLines, "[lfs \"CustomTransfer.test\"]\n\tpath = domovoi-inert-label\n")
    try {
      expect(classify("lfs.CustomTransfer.test.path", "domovoi-inert-label")).toEqual({ driver: "test", operation: "lfs-transfer-path" })
      await expect(isolatedValue(worktree, "lfs.CustomTransfer.test.path")).rejects.toMatchObject({ code: 1 })
    } finally {
      restore()
    }
  })

  // Git accepts a filter driver named by an empty subsection, `[filter ""]`,
  // printed as filter..clean. Rather than follow it through every check,
  // Domovoi refuses any such driver before isolation, naming the key (ruling
  // Q319); so for an empty-named Git LFS extension or custom transfer.
  it.each([
    ["a local empty override of a global label", "[filter \"\"]\n\tclean = domovoi-inert-label\n", "[filter \"\"]\n\tclean =\n", "filter..clean"],
    ["a required that is not a boolean", "", "[filter \"\"]\n\trequired = maybe\n", "filter..required"],
    ["required=true with no command", "", "[filter \"\"]\n\trequired = true\n", "filter..required"],
    ["an empty-named Git LFS extension", "", "[lfs \"extension.\"]\n\tclean =\n", "lfs.extension..clean"],
  ])("refuses a filter driver with an empty name: %s", async (_label, global, local, key) => {
    const { worktree, restore } = await sessionWorktree(() => global, local)
    try {
      await expect(readGitFilterSettings(worktree))
        .rejects.toMatchObject({ name: "RepositoryGitConfigUnreadableError", message: expect.stringContaining(key) })
    } finally {
      restore()
    }
  })
})
