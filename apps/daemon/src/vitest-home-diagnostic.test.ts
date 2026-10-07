import { execFile, fork, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createEmptyWorkspace, demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { creationTestAgent, creationTestRuntime } from "./session-creation-recovery.fixture.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { fixtureStartupTimeoutMs } from "./test-wait-for.js"
import { GitWorkspaceService } from "./workspace.js"

// ONE-OFF CI-2 diagnostic. The original recovery test and all its assertions
// are copied below with timing marks. No production timeout or behavior changes.
// Both parent and child always use scratch HOME, never the native user home.
const execute = promisify(execFile)
type Mode = "create" | "fork"
type Phase = "before-receipt" | "after-receipt" | "during-cleanup"
type Arm = "fresh" | "warm" | "warm-prime"

async function removeScratch(path: string) {
  await rm(path, { recursive: true, force: true, maxRetries: 25, retryDelay: 20 })
}

async function sample(arm: Arm, home: string, mode: Mode, phase: Phase) {
  const directories: string[] = []
  const timings: Record<string, number> = {}
  const started = performance.now()
  let previous = started
  let passed = false
  const mark = (operation: string) => {
    const now = performance.now()
    timings[operation] = Math.round(now - previous)
    previous = now
  }
  vi.stubEnv("HOME", home)
  vi.stubEnv("USERPROFILE", home)
  try {
    expect(homedir()).toBe(home)
    expect(home).not.toBe(userInfo().homedir)
    await recover(mode, phase, directories, mark)
    passed = true
  } finally {
    const recoveryMs = Math.round(performance.now() - started)
    vi.unstubAllEnvs()
    try {
      for (const directory of directories) await removeScratch(directory)
    } finally {
      mark("scratch-cleanup")
      console.log("T18_RECOVERY_DIAGNOSTIC", JSON.stringify({
        arm, mode, phase, passed, recoveryMs, timings,
      }))
    }
  }
}

async function recover(mode: Mode, phase: Phase, directories: string[], mark: (operation: string) => void) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-creation-recovery-"))
  directories.push(root)
  mark("scratch-root")
  const repository = join(root, "repository")
  const workspace = new GitWorkspaceService(join(root, "worktrees"))
  const git = (args: string[]) => execute("git", ["-C", repository, ...args])
  await execute("git", ["init", "--initial-branch=main", repository])
  await git(["config", "user.name", "Fixture"])
  await git(["config", "user.email", "fixture@example.test"])
  await git(["config", "core.autocrlf", "false"])
  await writeFile(join(repository, "README.md"), "preserved repository\n")
  await git(["add", "README.md"])
  await git(["commit", "-m", "fixture"])
  mark("repository-setup")
  const seed = createEmptyWorkspace(structuredClone(demoWorkspace.machine))
  seed.machine.providers = []
  seed.project = { ...demoWorkspace.project!, id: "project-recovery", path: repository, branch: "main" }
  if (mode === "fork") {
    const source = await workspace.createSessionWorkspace(repository, "session-source")
    seed.sessions.push({ id: "session-source", projectId: seed.project.id, title: "Source", state: "idle",
      runtime: creationTestRuntime, changedFiles: 0, testsPassed: 0, testsFailed: 0,
      updatedAt: "2026-09-12T12:00:00.000Z", workspacePath: source.path, baseCommit: source.baseCommit })
    seed.activeSessionId = "session-source"
    seed.thread.push({ id: "checkpoint-source", sessionId: "session-source", kind: "checkpoint", reason: "session-start",
      label: "Source checkpoint", commit: source.baseCommit, createdAt: "2026-09-12T12:00:00.000Z" })
  }
  mark("source-workspace")
  await writeFile(join(root, "seed.json"), JSON.stringify(seed))
  // Child workers must resolve the built protocol, including build-version.
  // Match the existing production fixture's tsx configuration.
  const tsconfig = join(root, "fixture-tsconfig.json")
  await writeFile(tsconfig, JSON.stringify({ compilerOptions: { paths: {} } }))
  const statePath = join(root, "state.sqlite")
  const initialStore = new SqliteWorkspaceStore(statePath, seed)
  initialStore.close()
  mark("seed-store")
  const deadline = OperationDeadline.start(fixtureStartupTimeoutMs(process.platform))
  let child: ChildProcess | undefined
  let exited: Promise<unknown> | undefined
  let diagnostics = ""
  let daemon: DomovoiDaemon | undefined
  try {
    child = fork(new URL("./session-creation-recovery.fixture.ts", import.meta.url), ["--creation-crash-fixture", root, mode, phase], {
      execArgv: ["--import", import.meta.resolve("tsx")],
      env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
      stdio: ["ignore", "ignore", "pipe", "ipc"], signal: deadline.signal, killSignal: "SIGKILL",
    })
    child.stderr!.on("data", (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString()).slice(-8_192) })
    exited = new Promise((resolve) => child!.once("exit", (code, signal) => resolve({ code, signal })))
    const created = new Promise<{ sessionId: string; path: string }>((resolve, reject) => {
      child!.once("error", reject)
      child!.on("message", (message: { state?: string; sessionId: string; path: string }) => { if (message.state === "created") resolve(message) })
      void exited!.then((result) => reject(new Error(`Setup fixture exited before creating its worktree: ${JSON.stringify(result)} ${diagnostics}`)))
    })
    const interrupted = await beforeDeadline(created, deadline)
    mark("fork-to-created")
    expect(child.kill("SIGKILL")).toBe(true)
    await beforeDeadline(exited, deadline)
    mark("kill-to-exit")
    expect(diagnostics).not.toContain("Domovoi mutation failed")
    deadline.clear()
    let startedThreads = 0
    const reopen = async (cycle: number): Promise<WorkspaceSnapshot> => {
      const store = new SqliteWorkspaceStore(statePath, seed)
      mark(`reopen-${cycle}-store`)
      daemon = new DomovoiDaemon({ port: 0, store, workspaceService: workspace,
        agents: { codex: creationTestAgent(() => { startedThreads++ }) } })
      mark(`reopen-${cycle}-constructor`)
      await daemon.start()
      mark(`reopen-${cycle}-start`)
      const snapshot = store.load()
      mark(`reopen-${cycle}-load`)
      return snapshot
    }
    const recovered = await reopen(1)
    const session = recovered.sessions.find(({ id }) => id === interrupted.sessionId)
    expect(session).toMatchObject({ state: "failed" })
    if (phase === "after-receipt") {
      expect(await realpath(session!.workspacePath!)).toBe(await realpath(interrupted.path))
    } else {
      expect(session).not.toHaveProperty("workspacePath")
      expect(recovered.thread.some((entry) => entry.sessionId === interrupted.sessionId && entry.kind === "system"
        && entry.detail?.includes(interrupted.sessionId))).toBe(true)
    }
    expect(session).not.toHaveProperty("providerThreadId")
    expect(recovered.thread.some((entry) => entry.sessionId === interrupted.sessionId && entry.kind === "system"
      && entry.body.includes("interrupted"))).toBe(true)
    expect(startedThreads).toBe(0)
    await expect(readFile(join(interrupted.path, "uncommitted.txt"), "utf8")).resolves.toBe("preserve interrupted setup\n")
    if (mode === "fork") {
      expect(recovered.activeSessionId).toBe("session-source")
      expect(recovered.sessions.find(({ id }) => id === "session-source")).toEqual(seed.sessions[0])
    }
    mark("recovery-assertions")
    await daemon!.stop()
    mark("stop-1")
    daemon = undefined
    const reopened = await reopen(2)
    expect(reopened.sessions.filter(({ id }) => id === interrupted.sessionId)).toHaveLength(1)
    expect(startedThreads).toBe(0)
    mark("reopen-assertions")
  } finally {
    deadline.clear()
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    if (exited) await exited
    if (daemon) await daemon.stop()
    mark("stop-2-or-failure-cleanup")
  }
}

describe.skipIf(process.platform !== "darwin")("one-off macOS recovery HOME diagnostic", () => {
  let warmHome: string
  beforeAll(async () => {
    warmHome = await mkdtemp(join(tmpdir(), "domovoi-recovery-warm-home-"))
  })
  afterAll(async () => { if (warmHome) await removeScratch(warmHome) })

  // Prime the reused HOME with the same recovery, including both parent cycles.
  // Timing this also records the first call before module/JIT caches are warm.
  it("primes the reused scratch HOME", async () => {
    await sample("warm-prime", warmHome, "create", "before-receipt")
  }, 60_000)

  // Include the unaffected phase as a control. Reverse the arm and phase
  // order for fork so cold process state is not always blamed on one phase.
  for (const mode of ["create", "fork"] as const) {
    const phases: Phase[] = mode === "create"
      ? ["before-receipt", "after-receipt", "during-cleanup"]
      : ["during-cleanup", "after-receipt", "before-receipt"]
    const arms = mode === "create" ? ["fresh", "warm"] as const : ["warm", "fresh"] as const
    for (const phase of phases) {
      for (const arm of arms) {
        it(`times ${mode} ${phase} with ${arm} scratch HOME`, async () => {
          const home = arm === "fresh"
            ? await mkdtemp(join(tmpdir(), "domovoi-recovery-fresh-home-")) : warmHome
          try { await sample(arm, home, mode, phase) }
          finally { if (arm === "fresh") await removeScratch(home) }
        }, 60_000)
      }
    }
  }
})
