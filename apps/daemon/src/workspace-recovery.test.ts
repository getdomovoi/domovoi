import { execFile, fork, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { fixtureStartupTimeoutMs, waitForFixtureStartup } from "./test-wait-for.js"
import { GitWorkspaceService } from "./workspace.js"

const execute = promisify(execFile)
const directories: string[] = []
afterEach(async () => { await removeScratchDirectories(directories) })

describe("worktree crash recovery", () => {
  it.each(["before-git", "during-git", "after-git-death", "after-git-abort"])("uses recorded Git settlement for restore recovery: %s", async (mode) => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-worktree-recovery-"))
    directories.push(scratch)
    const repository = join(scratch, "repository")
    const root = join(scratch, "worktrees")
    const bundle = join(scratch, "repository.bundle")
    const git = (args: string[]) => execute("git", ["-C", repository, ...args])
    await execute("git", ["init", repository])
    await git(["config", "user.name", "Fixture"])
    await git(["config", "user.email", "fixture@example.test"])
    await git(["config", "core.autocrlf", "false"])
    await writeFile(join(repository, "README.md"), "preserved work\n")
    await git(["add", "README.md"])
    await git(["commit", "-m", "fixture"])
    await git(["bundle", "create", bundle, "HEAD"])

    const deadline = OperationDeadline.start(fixtureStartupTimeoutMs(process.platform))
    let child: ChildProcess | undefined
    let exited: Promise<unknown> | undefined
    let diagnostics = ""
    let gitPid: number | undefined
    let holdPid: number | undefined
    let holdParentPid: number | undefined
    const stateOf = (pid: number | undefined) => {
      if (pid === undefined) return "unrecorded"
      try { process.kill(pid, 0); return "alive" } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return "absent"
        throw error
      }
    }
    const recordWriters = (phase: string) => console.info(JSON.stringify({ phase, platform: process.platform,
      owner: { pid: child?.pid, state: stateOf(child?.pid) },
      git: { pid: gitPid, state: stateOf(gitPid) }, descendant: { pid: holdPid, state: stateOf(holdPid) },
      descendantParent: { pid: holdParentPid, state: stateOf(holdParentPid) } }))
    const waitForGitExit = async () => {
      for (const pid of new Set([gitPid, holdPid, holdParentPid])) {
        if (pid === undefined) continue
        await waitForFixtureStartup(`owned writer ${pid} exit`, () => {
          if (stateOf(pid) === "absent") return
          throw new Error(`Owned writer ${pid} is still alive`)
        })
      }
    }
    try {
      child = fork(new URL("./workspace-recovery.fixture.ts", import.meta.url), [root, repository, bundle, mode], {
        execArgv: ["--import", import.meta.resolve("tsx")],
        stdio: ["ignore", "ignore", "pipe", "ipc"], signal: deadline.signal, killSignal: "SIGKILL",
      })
      child.stderr!.on("data", (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString()).slice(-8_192) })
      exited = new Promise((resolve) => child!.once("exit", (code, signal) => resolve({ code, signal })))
      const claimed = new Promise<void>((resolve, reject) => {
        child!.once("error", reject)
        child!.on("message", (message: { state?: string }) => { if (message.state === "claimed") resolve() })
        void exited!.then((result) => reject(new Error(`Restore fixture exited before its claim: ${JSON.stringify(result)} ${diagnostics}`)))
      })
      await beforeDeadline(claimed, deadline)
      if (mode !== "before-git") {
        await waitForFixtureStartup("Git child holding after launch", async () => {
          const holding = JSON.parse(await readFile(join(root, "child-ready"), "utf8")) as { pid: number; parentPid: number }
          expect(Number.isSafeInteger(holding.pid) && holding.pid > 0).toBe(true)
          expect(Number.isSafeInteger(holding.parentPid) && holding.parentPid > 0).toBe(true)
          holdPid = holding.pid
          holdParentPid = holding.parentPid
          console.info(JSON.stringify({ phase: "descendant-ready", ...holding }))
        })
        const owner = JSON.parse(await readFile(join(root, ".restore-leases", "session-recovery.json"), "utf8")) as { children: number[] }
        expect(owner.children).toHaveLength(1)
        gitPid = owner.children[0]!
        const ancestry = await processAncestry(holdPid!, deadline)
        console.info(JSON.stringify({ phase: "descendant-ancestry", gitPid, ancestry }))
        expect(ancestry, "Holding fixture must descend from the recorded Git launcher").toContain(gitPid)
        expect(ancestry[1]).toBe(holdParentPid)
        recordWriters("before-owner-death")
        expect(stateOf(gitPid)).toBe("alive")
        expect(stateOf(holdPid)).toBe("alive")
      }
      const successor = new GitWorkspaceService(root)
      await expect(successor.restoreSessionFromBundle(bundle, "session-recovery", { repositoryPath: repository }))
        .rejects.toThrow("Session worktree already exists")

      if (mode === "after-git-abort") child.send("abort-git")
      else expect(child.kill("SIGKILL")).toBe(true)
      await beforeDeadline(exited, deadline)
      if (mode !== "before-git") {
        if (mode === "after-git-death") {
          if (stateOf(gitPid) === "alive") process.kill(gitPid!, "SIGKILL")
          await waitForFixtureStartup("recorded Git launcher exit", () => expect(stateOf(gitPid)).toBe("absent"))
          expect(stateOf(holdPid)).toBe("alive")
        }
        recordWriters("after-owner-death")
        await expect(successor.restoreSessionFromBundle(bundle, "session-recovery", { repositoryPath: repository }))
          .rejects.toThrow(stateOf(gitPid) === "alive" ? `Recorded Git child ${gitPid} is still alive` : "descendant liveness")
        await writeFile(join(root, "child-release"), "finish")
        await waitForGitExit()
        recordWriters("after-writer-release")
        await expect(successor.restoreSessionFromBundle(bundle, "session-recovery", { repositoryPath: repository }))
          .rejects.toThrow("descendant liveness")
        // Model inspection after every known fixture writer has stopped.
        // Production never clears an uncertain claim from PID absence alone.
        await unlink(join(root, ".restore-claims", "session-recovery"))
      }
      await expect(successor.restoreSessionFromBundle(bundle, "session-recovery", { repositoryPath: repository }))
        .resolves.toMatchObject({ branch: "domovoi/session-recovery" })
      await expect(readFile(join(root, "session-recovery", "README.md"), "utf8")).resolves.toBe("preserved work\n")
    } finally {
      deadline.clear()
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      const cleanup = OperationDeadline.start(10_000)
      try {
        if (exited) await beforeDeadline(exited, cleanup)
        if (mode !== "before-git") {
          await writeFile(join(root, "child-release"), "finish")
          await waitForGitExit()
        }
      } finally { cleanup.clear() }
    }
  })
})

async function processAncestry(pid: number, deadline: OperationDeadline): Promise<number[]> {
  // Take one bounded OS snapshot while the owner and holder are alive. The
  // Git shell/wrapper may add intermediaries, especially on Windows.
  deadline.throwIfExpired()
  const options = {
    timeout: Math.max(1, Math.ceil(deadline.remainingMs())), signal: deadline.signal,
    maxBuffer: 1_048_576, windowsHide: true,
  }
  let records: unknown
  if (process.platform === "win32") {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      '$ErrorActionPreference = "Stop"; $rows = @(Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId, ParentProcessId); ConvertTo-Json -InputObject $rows -Compress',
    ], options)
    records = JSON.parse(stdout)
  } else {
    const { stdout } = await execute("ps", ["-e", "-o", "pid=", "-o", "ppid="], options)
    records = stdout.trim().split("\n").map((line) => {
      const [processId, parentId] = line.trim().split(/\s+/)
      return { ProcessId: Number(processId), ParentProcessId: Number(parentId) }
    })
  }
  // Both commands must exit 0. Missing tools, access failures, malformed data
  // and resource/time limits refuse the proof rather than skipping ancestry.
  const id = z.number().int().min(0).max(4_294_967_295)
  const rows = z.array(z.object({ ProcessId: id, ParentProcessId: id })).min(1).max(16_384).parse(records)
  const parents = new Map(rows.map((row) => [row.ProcessId, row.ParentProcessId]))
  const ancestry: number[] = []
  const seen = new Set<number>()
  let current: number | undefined = pid
  while (current !== undefined && current > 0 && !seen.has(current) && ancestry.length < 64) {
    ancestry.push(current)
    seen.add(current)
    current = parents.get(current)
  }
  return ancestry
}
