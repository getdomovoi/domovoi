import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { ClaudeAgentSdkAdapter } from "./claude.js"
import { runningClaudeProcesses, type ListWindowsChildren } from "./claude-process.js"
import { MachineCredentialStore } from "./machine-credentials.js"
import { OperationDeadline } from "./operation-deadline.js"
import { createProductionDaemonWithDependencies, productionDaemonDependencies } from "./production-daemon.js"
import { claimProfile, ProfileAlreadyOwnedError } from "./profile-lease.js"
import { DomovoiDaemon } from "./server.js"
import { installShutdownHandlers } from "./shutdown.js"
import { fakeClaudeChild, fakeClaudePid, spawningClaudeFactory } from "./test-claude-process.js"
import { asyncTestCredentials } from "./test-machine-credentials.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"

const roots: string[] = []
const claudes: number[] = []
afterEach(async () => {
  // Only the fake Claude processes these tests started.
  for (const pid of claudes.splice(0)) {
    try { process.kill(pid, "SIGKILL") } catch { /* Already gone. */ }
  }
  await removeScratchDirectories(roots)
})

async function daemonWith(adapter: ClaudeAgentSdkAdapter, homeDirectory: string) {
  const lease = claimProfile(homeDirectory)
  const handle = await createProductionDaemonWithDependencies({ homeDirectory, environment: { DOMOVOI_PORT: "0" } }, {
    ...productionDaemonDependencies,
    createProviderProbe: () => ({ inspect: async () => [] }),
    createMachineCredentials: () => asyncTestCredentials(new MachineCredentialStore({ get: () => undefined, set: () => {}, delete: () => {} })),
    createDaemon: (options) => new DomovoiDaemon({ ...options, port: 0, agents: { "claude-code": adapter } }),
  }, { lease, deadline: OperationDeadline.start(30_000) })
  await handle.start()
  const signals = new EventEmitter()
  const exit = vi.fn()
  const writeStderr = vi.fn()
  installShutdownHandlers({
    removeEndpointFile: async () => {},
    stopDaemon: () => handle.stop(),
    exit,
    writeStderr,
    runningProcesses: runningClaudeProcesses,
  }, signals as unknown as NodeJS.Process)
  return { lease, signals, exit, writeStderr }
}

// Security review round 1 of #647, F4 and Q105: a signal stop whose Claude
// process would not die exited the daemon, and the exit released the profile
// lock to the next owner while that process still ran.
it("keeps the daemon and its profile lease after a signal while Claude will not exit, and exits once it has", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-claude-signal-"))
  roots.push(homeDirectory)
  const stuck = fakeClaudeChild({ exitsOnEof: false })
  const { factory } = spawningClaudeFactory()
  const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
    spawn: () => stuck.process, platform: "linux", shutdownGraceMs: 20, killGraceMs: 20,
  })
  const lease = claimProfile(homeDirectory)
  const handle = await createProductionDaemonWithDependencies({ homeDirectory, environment: { DOMOVOI_PORT: "0" } }, {
    ...productionDaemonDependencies,
    createProviderProbe: () => ({ inspect: async () => [] }),
    createMachineCredentials: () => asyncTestCredentials(new MachineCredentialStore({ get: () => undefined, set: () => {}, delete: () => {} })),
    createDaemon: (options) => new DomovoiDaemon({ ...options, port: 0, agents: { "claude-code": adapter } }),
  }, { lease, deadline: OperationDeadline.start(30_000) })
  await handle.start()
  const threadId = await adapter.startThread({ cwd: homeDirectory, runtime: {
    provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false,
  } })
  const signals = new EventEmitter()
  const exit = vi.fn()
  const writeStderr = vi.fn()
  installShutdownHandlers({
    removeEndpointFile: async () => {},
    stopDaemon: () => handle.stop(),
    exit,
    writeStderr,
    runningProcesses: runningClaudeProcesses,
  }, signals as unknown as NodeJS.Process)

  try {
    signals.emit("SIGTERM")
    await waitForDaemon(() => expect(writeStderr).toHaveBeenCalledWith(
      `domovoid: Claude process ${fakeClaudePid} (Claude session ${threadId}) is still running. The profile lock stays held until it exits.\n`,
    ))
    expect(exit).not.toHaveBeenCalled()
    expect(() => claimProfile(homeDirectory)).toThrow(ProfileAlreadyOwnedError)

    stuck.exit("SIGKILL")
    await waitForDaemon(() => expect(exit).toHaveBeenCalledWith(1))
    expect(exit).toHaveBeenCalledOnce()
  } finally {
    stuck.exit("SIGKILL")
    // The exit above is a spy, so this process still holds the lease the
    // daemon kept; hand it back so the scratch directory can be removed.
    try { lease.release() } catch { /* Released by the daemon. */ }
  }
})

// Security review round 2 of #647, R2-F1: once Claude itself had exited, a
// group kill the kernel refused counted as success, and the shutdown released
// the profile lease while a tool Claude started could still run.
it("keeps the daemon and its profile lease after a signal while a tool Claude started cannot be seen to exit", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-claude-tool-signal-"))
  roots.push(homeDirectory)
  const claude = fakeClaudeChild()
  let tool = true
  const refused = (code: string) => Object.assign(new Error(`kill ${code}`), { code, syscall: "kill" })
  const { factory } = spawningClaudeFactory()
  const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
    spawn: () => claude.process,
    probe: () => { throw refused(tool ? "EPERM" : "ESRCH") },
    platform: "linux",
    shutdownGraceMs: 20,
    killGraceMs: 20,
  })
  const lease = claimProfile(homeDirectory)
  const handle = await createProductionDaemonWithDependencies({ homeDirectory, environment: { DOMOVOI_PORT: "0" } }, {
    ...productionDaemonDependencies,
    createProviderProbe: () => ({ inspect: async () => [] }),
    createMachineCredentials: () => asyncTestCredentials(new MachineCredentialStore({ get: () => undefined, set: () => {}, delete: () => {} })),
    createDaemon: (options) => new DomovoiDaemon({ ...options, port: 0, agents: { "claude-code": adapter } }),
  }, { lease, deadline: OperationDeadline.start(30_000) })
  await handle.start()
  const threadId = await adapter.startThread({ cwd: homeDirectory, runtime: {
    provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false,
  } })
  const signals = new EventEmitter()
  const exit = vi.fn()
  const writeStderr = vi.fn()
  installShutdownHandlers({
    removeEndpointFile: async () => {},
    stopDaemon: () => handle.stop(),
    exit,
    writeStderr,
    runningProcesses: runningClaudeProcesses,
  }, signals as unknown as NodeJS.Process)

  try {
    signals.emit("SIGTERM")
    await waitForDaemon(() => expect(writeStderr).toHaveBeenCalledWith(
      `domovoid: Claude process ${fakeClaudePid} (Claude session ${threadId}) is still running. The profile lock stays held until it exits.\n`,
    ))
    expect(claude.child.exitCode).toBe(0)
    expect(exit).not.toHaveBeenCalled()
    expect(() => claimProfile(homeDirectory)).toThrow(ProfileAlreadyOwnedError)

    tool = false
    await waitForDaemon(() => expect(exit).toHaveBeenCalledWith(1))
    expect(exit).toHaveBeenCalledOnce()
  } finally {
    tool = false
    try { lease.release() } catch { /* Released by the daemon. */ }
  }
})

// Security review round 3 of #647, R3-F2, with real processes: once its keeper
// was killed on its own, nothing could end a Claude that ignored the end of
// its input, and the shutdown waited on it for good. The sentinel ends it, and
// the lease stays until its process group is seen empty.
it.skipIf(process.platform === "win32")("ends Claude through the sentinel once its keeper was killed, and keeps the lease until its group is seen empty", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-claude-keeper-"))
  roots.push(homeDirectory)
  const path = join(homeDirectory, "claude.mjs")
  const pidFile = join(homeDirectory, "claude.pid")
  await writeFile(path, [
    "import { writeFileSync } from 'node:fs'",
    "writeFileSync(process.argv[2], String(process.pid))",
    "process.stdin.resume()",
    "setInterval(() => {}, 1000)",
  ].join("\n"))
  const keepers: ChildProcess[] = []
  let seen = false
  const { factory } = spawningClaudeFactory(process.execPath, [path, pidFile])
  const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
    spawn: (command, args, options) => {
      const child = nodeSpawn(command, args, options)
      keepers.push(child)
      return child
    },
    // Signal 0 finds the group until the test lets it be seen empty.
    probe: (pid) => { if (seen) process.kill(pid, 0) },
    shutdownGraceMs: 20,
    killGraceMs: 200,
  })
  const { lease, signals, exit, writeStderr } = await daemonWith(adapter, homeDirectory)
  try {
    const threadId = await adapter.startThread({ cwd: homeDirectory, runtime: {
      provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false,
    } })
    const claudePid = await waitForDaemon(async () => {
      const pid = Number(await readFile(pidFile, "utf8"))
      expect(pid).toBeGreaterThan(0)
      return pid
    })
    claudes.push(claudePid)
    const keeper = keepers[0]!
    process.kill(keeper.pid!, "SIGKILL")
    await waitForDaemon(() => expect(keeper.signalCode).toBe("SIGKILL"))

    signals.emit("SIGTERM")
    await waitForDaemon(() => expect(writeStderr).toHaveBeenCalledWith(
      `domovoid: Claude process ${keeper.pid} (Claude session ${threadId}) is still running. The profile lock stays held until it exits.\n`,
    ))
    // The stop ended Claude, though its keeper had gone.
    await waitForDaemon(() => expect(() => process.kill(claudePid, 0)).toThrow())
    expect(exit).not.toHaveBeenCalled()
    expect(() => claimProfile(homeDirectory)).toThrow(ProfileAlreadyOwnedError)

    seen = true
    await waitForDaemon(() => expect(exit).toHaveBeenCalledWith(1))
    expect(exit).toHaveBeenCalledOnce()
  } finally {
    seen = true
    // Ends a wait this test left, through the second-interrupt path.
    signals.emit("SIGINT")
    signals.emit("SIGINT")
    try { lease.release() } catch { /* Released by the daemon. */ }
  }
})

// Security review round 3 of #647, R3-F1 and Q109: a Windows Claude that had
// exited on its own counted as gone with everything it started, and the
// shutdown released the lease while a tool could still run. When what it left
// cannot be listed, the lease stays. Claude stays listed for the life of this
// file's registry, so this comes last.
it("keeps the daemon and its profile lease after a signal while what a Windows Claude left cannot be listed", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-claude-windows-list-"))
  roots.push(homeDirectory)
  const pid = fakeClaudePid + 50
  const claude = fakeClaudeChild({ pid })
  const listChildren = vi.fn<ListWindowsChildren>(async () => { throw new Error("PowerShell could not start") })
  const killTree = vi.fn(async (_pid: number) => {})
  const { factory } = spawningClaudeFactory()
  const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
    spawn: () => claude.process, killTree, listChildren, platform: "win32", shutdownGraceMs: 20, killGraceMs: 20,
  })
  const { lease, signals, exit, writeStderr } = await daemonWith(adapter, homeDirectory)
  try {
    const threadId = await adapter.startThread({ cwd: homeDirectory, runtime: {
      provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false,
    } })
    // Claude exits on its own, before any stop.
    claude.exit()
    await waitForDaemon(() => expect(listChildren).toHaveBeenCalledWith(pid, expect.any(Number)))

    signals.emit("SIGTERM")
    await waitForDaemon(() => expect(writeStderr).toHaveBeenCalledWith(
      `domovoid: Claude process ${pid} (Claude session ${threadId}) is still running. The profile lock stays held until it exits.\n`,
    ))
    expect(exit).not.toHaveBeenCalled()
    expect(() => claimProfile(homeDirectory)).toThrow(ProfileAlreadyOwnedError)
    // Claude's own pid may name another process: no taskkill of it.
    expect(killTree).not.toHaveBeenCalled()
  } finally {
    signals.emit("SIGINT")
    signals.emit("SIGINT")
    await waitForDaemon(() => expect(exit).toHaveBeenCalledOnce())
    try { lease.release() } catch { /* Released by the daemon. */ }
  }
})
