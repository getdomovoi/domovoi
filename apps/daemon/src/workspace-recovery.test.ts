import { execFile, fork, type ChildProcess } from "node:child_process"
import { writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { fixtureStartupTimeoutMs } from "./test-wait-for.js"
import { cleanupRecoveryWriters, recoveryFixtureBudgets, runRecoveryPhase, waitForRecoveryCondition } from "./test-workspace-recovery.js"
import { GitWorkspaceService } from "./workspace.js"

const execute = promisify(execFile)
const directories: string[] = []
// The ancestry snapshot spawns PowerShell on Windows to walk the holder's
// parents; it gets its own budget rather than the fixture's, per the rule in
// test-wait-for.ts that a wait names its class.
const processSnapshotTimeoutMs = process.platform === "win32" ? 45_000 : 10_000
const budgets = recoveryFixtureBudgets(fixtureStartupTimeoutMs(process.platform), processSnapshotTimeoutMs)
afterEach(async () => { await removeScratchDirectories(directories) })

describe("worktree crash recovery", () => {
  it.each(["before-git", "during-git", "after-git-death", "after-git-abort"])("uses recorded Git settlement for restore recovery: %s", async (mode) => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-worktree-recovery-"))
    directories.push(scratch)
    const repository = join(scratch, "repository")
    const root = join(scratch, "worktrees")
    const bundle = join(scratch, "repository.bundle")
    await mkdir(root)
    const sequence = OperationDeadline.start(budgets.sequenceMs)
    const started = performance.now()
    let child: ChildProcess | undefined
    let exited: Promise<unknown> | undefined
    let diagnostics = ""
    let gitPid: number | undefined
    let holdPid: number | undefined
    let holdParentPid: number | undefined
    const failures: unknown[] = []
    const stateOf = (pid: number | undefined) => {
      if (pid === undefined) return "unrecorded"
      try { process.kill(pid, 0); return "alive" } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return "absent"
        throw error
      }
    }
    const recordWriters = (phase: string) => console.info(JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started), platform: process.platform,
      owner: { pid: child?.pid, state: stateOf(child?.pid) },
      git: { pid: gitPid, state: stateOf(gitPid) }, descendant: { pid: holdPid, state: stateOf(holdPid) },
      descendantParent: { pid: holdParentPid, state: stateOf(holdParentPid) } }))
    const waitForGitExit = (deadline: OperationDeadline) => waitForRecoveryCondition(deadline,
      () => [gitPid, holdPid, holdParentPid].every((pid) => pid === undefined || stateOf(pid) === "absent"))
    try {
      await runRecoveryPhase("repository", sequence, budgets.phaseMs, async (deadline) => {
        const git = (args: string[]) => execute("git", args, {
          signal: deadline.signal, timeout: Math.max(1, Math.ceil(deadline.remainingMs())), killSignal: "SIGKILL",
        })
        await git(["init", repository])
        await git(["-C", repository, "config", "user.name", "Fixture"])
        await git(["-C", repository, "config", "user.email", "fixture@example.test"])
        await git(["-C", repository, "config", "core.autocrlf", "false"])
        await writeFile(join(repository, "README.md"), "preserved work\n")
        await git(["-C", repository, "add", "README.md"])
        await git(["-C", repository, "commit", "-m", "fixture"])
        await git(["-C", repository, "bundle", "create", bundle, "HEAD"])
      })
      await runRecoveryPhase("owner startup", sequence, budgets.phaseMs, async () => {
        child = fork(new URL("./workspace-recovery.fixture.ts", import.meta.url), [root, repository, bundle, mode, String(budgets.holderMs)], {
          execArgv: ["--import", import.meta.resolve("tsx")],
          stdio: ["ignore", "ignore", "pipe", "ipc"], signal: sequence.signal, killSignal: "SIGKILL",
        })
        child.stderr!.on("data", (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString()).slice(-8_192) })
        exited = new Promise((resolve) => child!.once("exit", (code, signal) => resolve({ code, signal })))
        await new Promise<void>((resolve, reject) => {
          child!.once("error", reject)
          child!.on("message", (message: { state?: string }) => { if (message.state === "claimed") resolve() })
          void exited!.then((result) => reject(new Error(`Restore fixture exited before its claim: ${JSON.stringify(result)} ${diagnostics}`)))
        })
      })
      if (mode !== "before-git") {
        await runRecoveryPhase("writer startup", sequence, budgets.phaseMs, (deadline) => waitForRecoveryCondition(deadline, async () => {
          let holding: { pid: number; parentPid: number }
          try { holding = JSON.parse(await readFile(join(root, "child-ready"), "utf8")) as typeof holding } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false
            throw error
          }
          expect(Number.isSafeInteger(holding.pid) && holding.pid > 0).toBe(true)
          expect(Number.isSafeInteger(holding.parentPid) && holding.parentPid > 0).toBe(true)
          holdPid = holding.pid
          holdParentPid = holding.parentPid
          console.info(JSON.stringify({ phase: "descendant-ready", ...holding }))
          return true
        }))
        const owner = JSON.parse(await readFile(join(root, ".restore-leases", "session-recovery.json"), "utf8")) as { children: number[] }
        expect(owner.children).toHaveLength(1)
        gitPid = owner.children[0]!
        const ancestry = await runRecoveryPhase("ancestry", sequence, budgets.ancestryMs, (deadline) => processAncestry(holdPid!, deadline))
        console.info(JSON.stringify({ phase: "descendant-ancestry", gitPid, ancestry }))
        expect(ancestry, "Holding fixture must descend from the recorded Git launcher").toContain(gitPid)
        expect(ancestry[1]).toBe(holdParentPid)
        recordWriters("before-owner-death")
        expect(stateOf(gitPid)).toBe("alive")
        expect(stateOf(holdPid)).toBe("alive")
      }
      const successor = new GitWorkspaceService(root)
      await runRecoveryPhase("settlement", sequence, budgets.phaseMs, async (deadline) => {
        await expect(successor.restoreSessionFromBundle(bundle, "session-recovery", { repositoryPath: repository }, deadline.signal))
          .rejects.toThrow("Session worktree already exists")

        if (mode === "after-git-abort") child!.send("abort-git")
        else expect(child!.kill("SIGKILL")).toBe(true)
        await beforeDeadline(exited!, deadline)
        if (mode !== "before-git") {
          if (mode === "after-git-death") {
            if (stateOf(gitPid) === "alive") process.kill(gitPid!, "SIGKILL")
            await waitForRecoveryCondition(deadline, () => stateOf(gitPid) === "absent")
            expect(stateOf(holdPid)).toBe("alive")
          }
          recordWriters("after-owner-death")
          await expect(successor.restoreSessionFromBundle(bundle, "session-recovery", { repositoryPath: repository }, deadline.signal))
            .rejects.toThrow(stateOf(gitPid) === "alive" ? `Recorded Git child ${gitPid} is still alive` : "descendant liveness")
          await writeFile(join(root, "child-release"), "finish")
          await waitForGitExit(deadline)
          recordWriters("after-writer-release")
          await expect(successor.restoreSessionFromBundle(bundle, "session-recovery", { repositoryPath: repository }, deadline.signal))
            .rejects.toThrow("descendant liveness")
          // Model inspection after every known fixture writer has stopped.
          // Production never clears an uncertain claim from PID absence alone.
          await unlink(join(root, ".restore-claims", "session-recovery"))
        }
      })
      await runRecoveryPhase("restore", sequence, budgets.phaseMs, async (deadline) => {
        await expect(successor.restoreSessionFromBundle(bundle, "session-recovery", { repositoryPath: repository }, deadline.signal))
          .resolves.toMatchObject({ branch: "domovoi/session-recovery" })
        await expect(readFile(join(root, "session-recovery", "README.md"), "utf8")).resolves.toBe("preserved work\n")
      })
    } catch (error) {
      failures.push(error)
    } finally { sequence.clear() }

    try {
      await cleanupRecoveryWriters({
        pids: () => [child?.pid, gitPid, holdPid, holdParentPid].filter((pid) => pid !== undefined),
        isAlive: (pid) => stateOf(pid) === "alive", exited,
        forceStops: [
          () => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL") },
          () => { if (mode !== "before-git") writeFileSync(join(root, "child-force-stop"), "stop") },
        ],
        release: async () => {
          if (mode !== "before-git") await writeFile(join(root, "child-release"), "finish")
          if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        },
      }, budgets.cleanupMs, budgets.reapMs)
    } catch (error) {
      failures.push(error)
    }
    try {
      const expired = await readFile(join(root, "child-expired"), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (expired !== undefined) throw new Error(`Holding writer exhausted its fixture watchdog: ${expired}`)
    } catch (error) {
      failures.push(error)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, "Recovery proof and fixture cleanup failed", { cause: failures[0] })
  }, budgets.testMs)
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
    // Walk the parents with Get-Process rather than enumerating Win32_Process
    // through WMI. The first WMI query on a runner starts its provider host:
    // measured at 3.4 to 8.8 s when idle and past 45 s under the suite's load,
    // while this walk stayed under 0.7 s on its first call. PowerShell 7 is
    // required for Process.Parent; without it the CIM query is the fallback.
    const walk = `$ErrorActionPreference = "Stop"; $rows = @(); $id = ${pid}; while ($id -gt 0 -and $rows.Count -lt 64) { $process = Get-Process -Id $id -ErrorAction SilentlyContinue; if (-not $process) { break }; $parent = if ($process.Parent) { $process.Parent.Id } else { 0 }; $rows += [pscustomobject]@{ ProcessId = $id; ParentProcessId = $parent }; if ($parent -eq 0 -or ($rows.ProcessId -contains $parent)) { break }; $id = $parent }; ConvertTo-Json -InputObject $rows -Compress`
    const enumerate = '$ErrorActionPreference = "Stop"; $rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId | Select-Object ProcessId, ParentProcessId); ConvertTo-Json -InputObject $rows -Compress'
    let stdout: string
    try {
      stdout = (await execute("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", walk], options)).stdout
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      stdout = (await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", enumerate], options)).stdout
    }
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
