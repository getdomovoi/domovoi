import { EventEmitter } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { ClaudeAgentSdkAdapter } from "./claude.js"
import { runningClaudeProcesses } from "./claude-process.js"
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
afterEach(async () => {
  await removeScratchDirectories(roots)
})

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
