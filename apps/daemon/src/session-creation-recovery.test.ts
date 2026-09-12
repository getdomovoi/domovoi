import { execFile, fork, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { once } from "node:events"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createEmptyWorkspace, demoWorkspace, protocolVersion, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { creationTestAgent, creationTestRuntime } from "./session-creation-recovery.fixture.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { fixtureStartupTimeoutMs, productionRpcTimeoutMs, waitForFixtureStartup } from "./test-wait-for.js"
import { GitWorkspaceService } from "./workspace.js"

const execute = promisify(execFile)
const directories: string[] = []
afterEach(() => vi.restoreAllMocks())
afterEach(async () => { await removeScratchDirectories(directories) })

describe("session creation crash recovery", () => {
  it.each([
    ["create", "before-receipt"], ["create", "after-receipt"],
    ["fork", "before-receipt"], ["fork", "after-receipt"],
    ["create", "during-cleanup"], ["fork", "during-cleanup"],
  ])("retains %s intent and its worktree when setup dies %s", async (mode, phase) => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-creation-recovery-"))
    directories.push(root)
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
    await writeFile(join(root, "seed.json"), JSON.stringify(seed))
    // Child workers must resolve the built protocol, including build-version.
    // Match the existing production fixture's tsx configuration.
    const tsconfig = join(root, "fixture-tsconfig.json")
    await writeFile(tsconfig, JSON.stringify({ compilerOptions: { paths: {} } }))
    const statePath = join(root, "state.sqlite")
    const initialStore = new SqliteWorkspaceStore(statePath, seed)
    initialStore.close()
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
      expect(child.kill("SIGKILL")).toBe(true)
      await beforeDeadline(exited, deadline)
      expect(diagnostics).not.toContain("Domovoi mutation failed")
      deadline.clear()
      let startedThreads = 0
      const reopen = async (): Promise<WorkspaceSnapshot> => {
        const store = new SqliteWorkspaceStore(statePath, seed)
        daemon = new DomovoiDaemon({ port: 0, store, workspaceService: workspace,
          agents: { codex: creationTestAgent(() => { startedThreads++ }) } })
        await daemon.start()
        return store.load()
      }
      const recovered = await reopen()
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
      await daemon!.stop()
      daemon = undefined
      const reopened = await reopen()
      expect(reopened.sessions.filter(({ id }) => id === interrupted.sessionId)).toHaveLength(1)
      expect(startedThreads).toBe(0)
    } finally {
      deadline.clear()
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      if (exited) await exited
      if (daemon) await daemon.stop()
    }
  })
})

describe("session creation cleanup", () => {
  it.each(["create", "fork"])("discards %s intent only after successful cleanup so another request can run", async (mode) => {
    const fixture = await liveCreationFixture(mode)
    try {
      fixture.agent.startThread = vi.fn()
        .mockRejectedValueOnce(new Error("injected provider setup failure"))
        .mockResolvedValue("provider-after-retry")
      const failed = await fixture.request()
      expect(failed.error).toBeDefined()
      expect(fixture.store.sessionCreations.pending("project-cleanup")).toEqual([])
      const retry = await fixture.request()
      expect(retry.error).toBeUndefined()
      expect(retry.result?.sessions.filter(({ providerThreadId }) => providerThreadId === "provider-after-retry")).toHaveLength(1)
      expect(fixture.store.sessionCreations.pending("project-cleanup")).toEqual([])
    } finally { await fixture.close() }
  })

  it("keeps a failed fork's evidence and refuses replay when worktree cleanup fails", async () => {
    const fixture = await liveCreationFixture("fork")
    try {
      fixture.agent.startThread = vi.fn().mockRejectedValue(new Error("injected provider setup failure"))
      const remove = vi.spyOn(fixture.workspace, "removeSessionWorkspace").mockRejectedValue(new Error("injected cleanup failure"))
      expect((await fixture.request()).error).toBeDefined()
      const pending = fixture.store.sessionCreations.pending("project-cleanup")
      expect(pending).toHaveLength(1)
      expect(pending[0]?.workspace).toBeDefined()
      expect((await fixture.request()).error).toMatchObject({
        code: -32602, message: "Session creation is already pending; preserve its worktree until setup or cleanup is resolved",
      })
      expect(fixture.agent.startThread).toHaveBeenCalledOnce()
      expect(remove).toHaveBeenCalledOnce()
      expect(fixture.store.sessionCreations.pending("project-cleanup")).toEqual(pending)
    } finally { await fixture.close() }
  })

  it("clears a cleaned fork intent after snapshot persistence fails", async () => {
    const fixture = await liveCreationFixture("fork")
    try {
      const stop = vi.spyOn(fixture.agent, "stopThread")
      vi.spyOn(fixture.store, "saveAsync").mockRejectedValueOnce(new Error("injected snapshot failure"))
      expect((await fixture.request()).error).toBeDefined()
      expect(stop).toHaveBeenCalledWith("fixture-provider-thread")
      expect(fixture.store.sessionCreations.pending("project-cleanup")).toEqual([])
      expect((await fixture.request()).error).toBeUndefined()
    } finally { await fixture.close() }
  })

  it.each(["create", "fork"])("cleans %s work after receipt publication fails, before any provider starts", async (mode) => {
    const fixture = await liveCreationFixture(mode, async ({ root }) => {
      const database = new DatabaseSync(join(root, "state.sqlite"))
      try {
        database.exec("CREATE TRIGGER refuse_creation_receipt BEFORE UPDATE ON session_creation_intents WHEN json_extract(NEW.record, '$.workspace') IS NOT NULL AND json_extract(NEW.record, '$.cleanupStarted') = 0 BEGIN SELECT RAISE(FAIL, 'injected receipt publication failure'); END")
      } finally { database.close() }
    })
    try {
      const remove = vi.spyOn(fixture.workspace, "removeSessionWorkspace")
      expect((await fixture.request()).error).toBeDefined()
      await waitForFixtureStartup("receipt failure cleanup settled", () => {
        expect(remove).toHaveBeenCalledOnce()
        expect(fixture.store.sessionCreations.pending("project-cleanup")).toEqual([])
      })
      const removedPath = remove.mock.calls[0]![0]
      await expect(readFile(join(removedPath, "README.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
      expect(fixture.agent.startThread).not.toHaveBeenCalled()
    } finally { await fixture.close() }
  })

  it.each(["create", "fork"])("returns durable %s success even when committed-intent cleanup fails", async (mode) => {
    const fixture = await liveCreationFixture(mode, async ({ root }) => {
      const database = new DatabaseSync(join(root, "state.sqlite"))
      try {
        database.exec("CREATE TRIGGER refuse_committed_intent_delete BEFORE DELETE ON session_creation_intents BEGIN SELECT RAISE(FAIL, 'injected committed-intent deletion failure'); END")
      } finally { database.close() }
    })
    try {
      const result = await fixture.request()
      expect(result.error).toBeUndefined()
      const created = result.result?.sessions.find(({ providerThreadId }) => providerThreadId === "fixture-provider-thread")
      expect(created).toMatchObject({ state: "idle", workspacePath: expect.any(String) })
      expect(fixture.store.load()?.sessions.find(({ id }) => id === created!.id)).toEqual(created)
      expect(fixture.store.sessionCreations.pending("project-cleanup")).toEqual([expect.objectContaining({ session: expect.objectContaining({ id: created!.id }) })])
      expect(fixture.agent.startThread).toHaveBeenCalledOnce()
      expect(fixture.errorSink).toHaveBeenCalledWith(expect.objectContaining({ context: "Domovoi could not clear committed session creation intents" }))
    } finally { await fixture.close() }
  })

  it("refuses worktree removal if cleanup intent cannot be persisted", async () => {
    const fixture = await liveCreationFixture("create", async ({ root }) => {
      const database = new DatabaseSync(join(root, "state.sqlite"))
      try {
        database.exec("CREATE TRIGGER refuse_cleanup_intent BEFORE UPDATE ON session_creation_intents WHEN json_extract(NEW.record, '$.cleanupStarted') = 1 BEGIN SELECT RAISE(FAIL, 'injected cleanup recording failure'); END")
      } finally { database.close() }
    })
    try {
      fixture.agent.startThread = vi.fn().mockRejectedValue(new Error("injected provider setup failure"))
      const remove = vi.spyOn(fixture.workspace, "removeSessionWorkspace")
      expect((await fixture.request()).error).toBeDefined()
      expect(remove).not.toHaveBeenCalled()
      const pending = fixture.store.sessionCreations.pending("project-cleanup")
      expect(pending).toHaveLength(1)
      expect(pending[0]?.cleanupStarted).toBe(false)
      await expect(readFile(join(pending[0]!.workspace!.path, "README.md"), "utf8")).resolves.toBe("preserve source\n")
    } finally { await fixture.close() }
  })

  it("retains a timed-out creation until its late worktree removal actually settles", async () => {
    const fixture = await liveCreationFixture("create", undefined, { agentTimeoutMs: 50 })
    const deadline = OperationDeadline.start(fixtureStartupTimeoutMs(process.platform))
    let releaseCreation!: () => void
    let releaseRemoval!: () => void
    let workspaceReady!: (path: string) => void
    let removalStarted!: () => void
    const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve })
    const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve })
    const created = new Promise<string>((resolve) => { workspaceReady = resolve })
    const removing = new Promise<void>((resolve) => { removalStarted = resolve })
    let creation: Promise<unknown> | undefined
    let removal: Promise<unknown> | undefined
    const createWorkspace = fixture.workspace.createSessionWorkspace.bind(fixture.workspace)
    const removeWorkspace = fixture.workspace.removeSessionWorkspace.bind(fixture.workspace)
    vi.spyOn(fixture.workspace, "createSessionWorkspace").mockImplementation((repository, id) => {
      // Model I/O which completes after the caller's abort. Gates, not elapsed
      // worktree timing, choose when setup and removal may settle.
      const operation = createWorkspace(repository, id).then(async (workspace) => {
        workspaceReady(workspace.path)
        await creationGate
        return workspace
      })
      creation = operation
      return operation
    })
    vi.spyOn(fixture.workspace, "removeSessionWorkspace").mockImplementation((path, signal) => {
      const operation = (async () => {
        removalStarted()
        await removalGate
        await removeWorkspace(path, signal)
      })()
      removal = operation
      return operation
    })
    let phase = "repository inspection"
    try {
      // Repository inspection is setup, not the operation this fixture times
      // out. Resolve real Git first so the short budget reaches creation.
      const repository = await beforeDeadline(fixture.workspace.inspect(fixture.repository), deadline)
      vi.spyOn(fixture.workspace, "inspect").mockResolvedValue(repository)
      phase = "creation timeout"
      expect((await fixture.request()).error).toMatchObject({ message: "Session workspace creation timed out" })
      phase = "late worktree creation"
      const path = await beforeDeadline(created, deadline)
      expect(fixture.store.sessionCreations.pending("project-cleanup")).toHaveLength(1)
      expect(fixture.agent.startThread).not.toHaveBeenCalled()
      releaseCreation()
      phase = "removal start"
      await beforeDeadline(removing, deadline)
      expect(fixture.store.sessionCreations.pending("project-cleanup")).toHaveLength(1)
      await expect(readFile(join(path, "README.md"), "utf8")).resolves.toBe("preserve source\n")
      releaseRemoval()
      phase = "removal settlement"
      await waitForFixtureStartup("late creation cleanup settled", () => {
        expect(fixture.store.sessionCreations.pending("project-cleanup")).toEqual([])
      })
      await expect(readFile(join(path, "README.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    } catch (error) {
      throw new Error(`Late creation cleanup fixture failed during ${phase}`, { cause: error })
    } finally {
      releaseCreation()
      releaseRemoval()
      deadline.clear()
      const cleanup = OperationDeadline.start(fixtureStartupTimeoutMs(process.platform))
      try {
        await beforeDeadline(Promise.allSettled([creation]), cleanup)
        // The creation continuation may start removal while it settles.
        await beforeDeadline(Promise.allSettled([removal]), cleanup)
      } finally { cleanup.clear(); await fixture.close() }
    }
  })
})

describe("session creation recovery boundaries", () => {
  it("restarts a verified worktree only after an explicit provider restart", async () => {
    const fixture = await liveCreationFixture("create", async (setup) => {
      await prepareInterruptedCreation(setup)
      injectOwnerProbe("ESRCH")
    })
    try {
      const recovered = (await fixture.rpc("workspace.get", {})).result!.sessions[0]!
      expect(recovered.state).toBe("failed")
      expect(recovered.workspacePath).toBeDefined()
      expect(recovered.providerThreadId).toBeUndefined()
      expect(fixture.agent.startThread).not.toHaveBeenCalled()
      const restarted = await fixture.rpc("session.restartProviderThread", { sessionId: recovered.id, client: "cli" })
      expect(restarted.error).toBeUndefined()
      expect(restarted.result?.sessions[0]).toMatchObject({ state: "idle", workspacePath: recovered.workspacePath,
        providerThreadId: "fixture-provider-thread" })
      expect(fixture.agent.startThread).toHaveBeenCalledExactlyOnceWith({ cwd: recovered.workspacePath, runtime: creationTestRuntime })
    } finally { await fixture.close() }
  })

  it.each(["alive", "EPERM", "EIO"])("defers an intent when its owner probe reports %s", async (outcome) => {
    const fixture = await liveCreationFixture("create", async (setup) => {
      await prepareInterruptedCreation(setup)
      injectOwnerProbe(outcome)
    })
    try {
      expect((await fixture.rpc("workspace.get", {})).result?.sessions).toEqual([])
      expect(fixture.store.sessionCreations.pending("project-cleanup")).toHaveLength(1)
      expect(fixture.agent.startThread).not.toHaveBeenCalled()
      expect((await fixture.rpc("session.restartProviderThread", { sessionId: "session-interrupted", client: "cli" })).error)
        .toMatchObject({ code: -32602, message: "Session does not exist" })
      expect(await readFile(join(fixture.root, "worktrees", "session-interrupted", "README.md"), "utf8")).toBe("preserve source\n")
    } finally { await fixture.close() }
  })

  it.each(["wrong-head", "symlink"])("preserves a %s receipt as a failed session without exposing the worktree", async (defect) => {
    const fixture = await liveCreationFixture("create", async (setup) => {
      const workspace = await prepareInterruptedCreation(setup, defect === "wrong-head")
      if (defect === "symlink") {
        const relocated = join(setup.root, "relocated-worktree")
        await rename(workspace.path, relocated)
        await symlink(relocated, workspace.path, process.platform === "win32" ? "junction" : "dir")
      }
      injectOwnerProbe("ESRCH")
    })
    try {
      const recovered = (await fixture.rpc("workspace.get", {})).result!
      expect(recovered.sessions).toEqual([expect.objectContaining({ id: "session-interrupted", state: "failed" })])
      expect(recovered.sessions[0]?.workspacePath).toBeUndefined()
      expect(recovered.sessions[0]?.providerThreadId).toBeUndefined()
      expect(recovered.thread.find(({ id }) => id === "creation-recovery-session-interrupted"))
        .toMatchObject({ detail: expect.stringContaining("could not be verified") })
      expect((await fixture.rpc("session.restartProviderThread", { sessionId: "session-interrupted", client: "cli" })).error)
        .toMatchObject({ code: -32602, message: "Session has no worktree" })
      expect(await readFile(join(fixture.root, "worktrees", "session-interrupted", "README.md"), "utf8")).toBe("preserve source\n")
      expect(fixture.agent.startThread).not.toHaveBeenCalled()
    } finally { await fixture.close() }
  })

  it("keeps the intent and prior snapshot when recovery persistence fails", async () => {
    let databasePath = ""
    let seed!: WorkspaceSnapshot
    await expect(liveCreationFixture("create", async (setup) => {
      await prepareInterruptedCreation(setup)
      databasePath = join(setup.root, "state.sqlite")
      seed = setup.seed
      injectOwnerProbe("ESRCH")
      vi.spyOn(setup.store, "saveAsync").mockRejectedValueOnce(new Error("injected recovery persistence failure"))
    })).rejects.toThrow("injected recovery persistence failure")
    const reopened = new SqliteWorkspaceStore(databasePath, seed)
    try {
      expect(reopened.load()?.sessions).toEqual([])
      expect(reopened.sessionCreations.pending("project-cleanup")).toHaveLength(1)
    } finally { reopened.close() }
  })

  it("does not duplicate a durable session when stale-intent deletion fails", async () => {
    const fixture = await liveCreationFixture("create", async (setup) => {
      const workspace = await prepareInterruptedCreation(setup)
      const session = setup.store.sessionCreations.pending("project-cleanup")[0]!.session
      const canonical = structuredClone(setup.seed)
      canonical.sessions.push({ ...session, state: "idle", workspacePath: workspace.path, baseCommit: workspace.baseCommit,
        providerThreadId: "already-saved-thread" })
      setup.store.save(canonical)
      const database = new DatabaseSync(join(setup.root, "state.sqlite"))
      try {
        database.exec("CREATE TRIGGER refuse_stale_intent_delete BEFORE DELETE ON session_creation_intents BEGIN SELECT RAISE(FAIL, 'injected stale-intent deletion failure'); END")
      } finally { database.close() }
      injectOwnerProbe("ESRCH")
    })
    try {
      const snapshot = (await fixture.rpc("workspace.get", {})).result!
      expect(snapshot.sessions).toHaveLength(1)
      expect(snapshot.sessions[0]?.providerThreadId).toBe("already-saved-thread")
      expect(snapshot.thread.some(({ id }) => id === "creation-recovery-session-interrupted")).toBe(false)
      expect(fixture.store.sessionCreations.pending("project-cleanup")).toHaveLength(1)
      expect(fixture.agent.startThread).not.toHaveBeenCalled()
      expect(fixture.errorSink).toHaveBeenCalledWith(expect.objectContaining({ context: "Domovoi could not clear committed session creation intents" }))
    } finally { await fixture.close() }
  })

  it("recovers a dormant project's intent only when that project opens", async () => {
    const fixture = await liveCreationFixture("create")
    let restarted: Awaited<ReturnType<typeof connectCreationFixture>> | undefined
    let initialClosed = false
    try {
      const path = join(fixture.root, "dormant-repository")
      await execute("git", ["clone", "--quiet", fixture.repository, path])
      const dormantPath = await realpath(path)
      const firstOpen = await fixture.rpc("project.open", { path: dormantPath, client: "cli" })
      expect(firstOpen.error).toBeUndefined()
      const dormant = firstOpen.result!
      const dormantId = dormant.project!.id
      const alias = join(fixture.root, "dormant-alias")
      await symlink(dormantPath, alias, process.platform === "win32" ? "junction" : "dir")
      const aliasOpen = await fixture.rpc("project.open", { path: alias, client: "cli" })
      expect(aliasOpen.error).toBeUndefined()
      expect(aliasOpen.result?.project).toEqual(dormant.project)
      process.stdout.write(`Dormant project identity: ${JSON.stringify({ requestedPath: dormantPath,
        repositoryRoot: dormant.project!.path, projectId: dormantId, aliasProjectId: aliasOpen.result?.project?.id })}\n`)
      const active = await fixture.rpc("project.open", { path: fixture.repository, client: "cli" })
      expect(active.error).toBeUndefined()
      await prepareInterruptedCreation({ ...fixture, repository: dormantPath, seed: dormant })
      await fixture.close()
      initialClosed = true
      injectOwnerProbe("ESRCH")
      const store = new SqliteWorkspaceStore(join(fixture.root, "state.sqlite"), active.result!)
      restarted = await connectCreationFixture("create", { ...fixture, seed: active.result!, store })
      expect((await restarted.rpc("workspace.get", {})).result?.project).toEqual(active.result?.project)
      expect((await restarted.rpc("workspace.get", {})).result?.sessions).toEqual([])
      expect(restarted.store.sessionCreations.pending(dormantId)).toHaveLength(1)
      const opened = await restarted.rpc("project.open", { path: dormantPath, client: "cli" })
      expect(opened.error).toBeUndefined()
      expect(opened.result?.project?.id).toBe(dormantId)
      expect(opened.result?.sessions).toEqual([expect.objectContaining({ id: "session-interrupted", state: "failed", workspacePath: expect.any(String) })])
      expect(restarted.store.sessionCreations.pending(dormantId)).toEqual([])
      expect(restarted.agent.startThread).not.toHaveBeenCalled()
    } finally {
      await restarted?.close()
      if (!initialClosed) await fixture.close()
    }
  })
})

type CreationSetup = {
  root: string; repository: string; seed: WorkspaceSnapshot;
  store: SqliteWorkspaceStore; workspace: GitWorkspaceService;
}
const recordedCreatorPid = 2_147_483_000

async function prepareInterruptedCreation(setup: CreationSetup, wrongHead = false) {
  const { store, workspace, repository, seed, root } = setup
  const created = await workspace.createSessionWorkspace(repository, "session-interrupted")
  store.sessionCreations.begin({ repositoryPath: repository, expectedWorkspacePath: workspace.sessionWorkspacePath("session-interrupted"),
    session: { id: "session-interrupted", projectId: seed.project!.id, title: "Interrupted", state: "failed", runtime: creationTestRuntime,
      changedFiles: 0, testsPassed: 0, testsFailed: 0, updatedAt: "2026-09-12T12:00:00.000Z" } })
  store.sessionCreations.complete("session-interrupted", { ...created, ...(wrongHead ? { baseCommit: "b".repeat(40) } : {}) })
  const database = new DatabaseSync(join(root, "state.sqlite"))
  try {
    database.prepare("UPDATE session_creation_intents SET record = json_set(record, '$.ownerPid', ?) WHERE session_id = ?")
      .run(recordedCreatorPid, "session-interrupted")
  } finally { database.close() }
  return created
}

function injectOwnerProbe(outcome: string) {
  const kill = process.kill.bind(process)
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid !== recordedCreatorPid) return kill(pid, signal)
    if (outcome === "alive") return true
    throw Object.assign(new Error(`injected owner probe ${outcome}`), { code: outcome })
  })
}

async function liveCreationFixture(mode: string, configure?: (setup: CreationSetup) => Promise<void>, options: { agentTimeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-creation-cleanup-"))
  directories.push(root)
  const repository = join(root, "repository")
  await execute("git", ["init", "--initial-branch=main", repository])
  const git = (args: string[]) => execute("git", ["-C", repository, ...args])
  await git(["config", "user.name", "Fixture"])
  await git(["config", "user.email", "fixture@example.test"])
  await git(["config", "core.autocrlf", "false"])
  await writeFile(join(repository, "README.md"), "preserve source\n")
  await git(["add", "README.md"])
  await git(["commit", "-m", "fixture"])
  const workspace = new GitWorkspaceService(join(root, "worktrees"))
  const seed = createEmptyWorkspace(structuredClone(demoWorkspace.machine))
  seed.machine.providers = []
  seed.project = { ...demoWorkspace.project!, id: "project-cleanup", path: repository, branch: "main" }
  if (mode === "fork") {
    const source = await workspace.createSessionWorkspace(repository, "session-source")
    seed.sessions.push({ id: "session-source", projectId: seed.project.id, title: "Source", state: "idle", runtime: creationTestRuntime,
      changedFiles: 0, testsPassed: 0, testsFailed: 0, updatedAt: "2026-09-12T12:00:00.000Z", workspacePath: source.path, baseCommit: source.baseCommit })
    seed.thread.push({ id: "checkpoint-source", sessionId: "session-source", kind: "checkpoint", reason: "session-start",
      label: "Source checkpoint", commit: source.baseCommit, createdAt: "2026-09-12T12:00:00.000Z" })
  }
  const store = new SqliteWorkspaceStore(join(root, "state.sqlite"), seed)
  const setup = { root, repository, seed, store, workspace }
  try { await configure?.(setup) } catch (error) { store.close(); throw error }
  return connectCreationFixture(mode, setup, options)
}

async function connectCreationFixture(mode: string, setup: CreationSetup, options: { agentTimeoutMs?: number } = {}) {
  const { store, workspace } = setup
  const agent = creationTestAgent()
  agent.startThread = vi.fn(agent.startThread)
  const errorSink = vi.fn()
  let daemon: DomovoiDaemon | undefined
  let socket: WebSocket | undefined
  const close = async () => { socket?.terminate(); if (daemon) await daemon.stop(); else store.close() }
  try {
    daemon = new DomovoiDaemon({ port: 0, store, workspaceService: workspace, agents: { codex: agent }, errorSink, ...options })
    const address = await daemon.start()
    const paired = store.devices.pair({ label: "creation-cleanup-fixture", binding: { kind: "client", client: "cli" } })
    socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
    const startup = OperationDeadline.start(fixtureStartupTimeoutMs(process.platform))
    try { await beforeDeadline(once(socket, "open"), startup) } finally { startup.clear() }
    let id = 0
    const rpc = async (method: string, params: unknown) => {
      const requestId = ++id
      type Response = { id?: number; error?: unknown; result?: WorkspaceSnapshot }
      let receive!: (bytes: WebSocket.RawData) => void
      const response = new Promise<Response>((resolve) => {
        receive = (bytes) => { const value = JSON.parse(String(bytes)) as Response; if (value.id === requestId) resolve(value) }
        socket!.on("message", receive)
      })
      const deadline = OperationDeadline.start(productionRpcTimeoutMs(process.platform))
      try {
        socket!.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
        return await beforeDeadline(response, deadline)
      } finally { deadline.clear(); socket!.off("message", receive) }
    }
    expect((await rpc("system.hello", { client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: paired.token })).error).toBeUndefined()
    return { ...setup, agent, errorSink, close, rpc, request: () => mode === "fork"
      ? rpc("session.fork", { sessionId: "session-source", checkpointId: "checkpoint-source", requestId: "cleanup-fork", client: "cli", runtime: creationTestRuntime })
      : rpc("session.create", { title: "Cleanup fixture", client: "cli", runtime: creationTestRuntime }) }
  } catch (error) { await close(); throw error }
}
