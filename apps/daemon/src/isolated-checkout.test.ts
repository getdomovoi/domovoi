import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { gitTeardownTimeoutMs, runGitProcess } from "./isolated-checkout.js"
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
