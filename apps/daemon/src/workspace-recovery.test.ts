import { execFile, fork, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { fixtureStartupTimeoutMs, waitForFixtureStartup } from "./test-wait-for.js"
import { GitWorkspaceService } from "./workspace.js"

const execute = promisify(execFile)
const directories: string[] = []
afterEach(async () => { await removeScratchDirectories(directories) })

describe("worktree crash recovery", () => {
  it.each(["before-git", "during-git"])("reclaims an interrupted restore only after its writers stop: %s", async (mode) => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-worktree-recovery-"))
    directories.push(scratch)
    const repository = join(scratch, "repository")
    const root = join(scratch, "worktrees")
    const bundle = join(scratch, "repository.bundle")
    const git = (args: string[]) => execute("git", ["-C", repository, ...args])
    await execute("git", ["init", repository])
    await git(["config", "user.name", "Fixture"])
    await git(["config", "user.email", "fixture@example.test"])
    await writeFile(join(repository, "README.md"), "preserved work\n")
    await git(["add", "README.md"])
    await git(["commit", "-m", "fixture"])
    await git(["bundle", "create", bundle, "HEAD"])

    const deadline = OperationDeadline.start(fixtureStartupTimeoutMs(process.platform))
    let child: ChildProcess | undefined
    let exited: Promise<unknown> | undefined
    let diagnostics = ""
    let gitPid: number | undefined
    const waitForGitExit = async () => {
      if (gitPid === undefined) return
      await waitForFixtureStartup("orphaned Git child exit", () => {
        try { process.kill(gitPid!, 0) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return
          throw error
        }
        throw new Error(`Recorded Git child ${gitPid} is still alive`)
      })
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
      if (mode === "during-git") {
        await waitForFixtureStartup("Git child holding after launch", async () => {
          await expect(readFile(join(root, "child-ready"), "utf8")).resolves.toBe("ready")
        })
        const owner = JSON.parse(await readFile(join(root, ".restore-leases", "session-recovery.json"), "utf8")) as { children: number[] }
        expect(owner.children).toHaveLength(1)
        gitPid = owner.children[0]!
      }
      const successor = new GitWorkspaceService(root)
      await expect(successor.restoreSessionFromBundle(bundle, "session-recovery", { repositoryPath: repository }))
        .rejects.toThrow("Session worktree already exists")

      expect(child.kill("SIGKILL")).toBe(true)
      await beforeDeadline(exited, deadline)
      if (mode === "during-git") {
        await expect(successor.restoreSessionFromBundle(bundle, "session-recovery", { repositoryPath: repository }))
          .rejects.toThrow(`Recorded Git child ${gitPid} is still alive`)
        await writeFile(join(root, "child-release"), "finish")
        await waitForGitExit()
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
        if (mode === "during-git") {
          await writeFile(join(root, "child-release"), "finish")
          await waitForGitExit()
        }
      } finally { cleanup.clear() }
    }
  })
})
