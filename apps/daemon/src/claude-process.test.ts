import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PassThrough } from "node:stream"

import type { Runtime } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ClaudeAgentSdkAdapter, type ClaudeQueryFactory } from "./claude.js"
import {
  runningClaudeProcesses,
  spawnClaudeProcess,
  stopClaudeProcess,
  windowsTreeKill,
  type ClaudeProcess,
  type ClaudeSpawn,
} from "./claude-process.js"
import { FakeClaudeQuery, fakeClaudeChild, fakeClaudePid, spawningClaudeFactory } from "./test-claude-process.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"

// Every command started through Node's spawn while this file runs, by the
// tests or by Domovoi, in order. Each still runs as it would.
const launched = vi.hoisted((): string[] => [])
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const recorded = (...args: Parameters<typeof actual.spawn>) => {
    launched.push(String(args[0]))
    return actual.spawn(...args)
  }
  return { ...actual, spawn: recorded }
})

// Security review round 1 of #647, Q103 and Q104. A stop kills everything the
// session started: on POSIX the whole process group, even when Claude exits on
// its own within the grace, and on Windows the process tree through taskkill.

const runtime: Runtime = {
  provider: "claude-code", model: "sonnet", reasoning: "high", permissionMode: "build", auto: false,
}
const scratchDirectories: string[] = []
const started: ChildProcess[] = []
const tools: number[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  // Only processes these tests started. One that has not exited is unreaped,
  // so on POSIX its pid still names its own process group: kill all of it.
  for (const child of started.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) continue
    if (process.platform === "win32") child.kill("SIGKILL")
    else try { process.kill(-child.pid, "SIGKILL") } catch { /* Already gone. */ }
  }
  for (const pid of tools.splice(0)) {
    try { process.kill(pid, "SIGKILL") } catch { /* Already gone. */ }
  }
  await removeScratchDirectories(scratchDirectories.splice(0))
})

const realSpawn: ClaudeSpawn = (command, args, options) => {
  const child = nodeSpawn(command, args, options)
  started.push(child)
  return child
}

async function script(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-claude-process-"))
  scratchDirectories.push(directory)
  const path = join(directory, "claude.mjs")
  await writeFile(path, source)
  return path
}

describe("the Windows process tree kill", () => {
  it("runs taskkill on the whole tree with fixed arguments, no shell and no window, and waits for it", async () => {
    const taskkill = new EventEmitter()
    const run = vi.fn(() => taskkill as ChildProcess)
    let settled = false
    const killing = windowsTreeKill(4_242, run, { SystemRoot: "C:\\Windows" }).then(() => { settled = true })

    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", "4242", "/T", "/F"],
      { cwd: "C:\\Windows\\System32", windowsHide: true, shell: false, stdio: "ignore" },
    )
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(settled).toBe(false)

    taskkill.emit("exit", 0, null)
    await killing
    expect(settled).toBe(true)
  })

  // Security review round 4 of #647, R4-F1: a bare name is looked up in the
  // current directory, then PATH, where the project or a tool can put its own
  // taskkill.exe. The system copy is named by SystemRoot, and a SystemRoot
  // that is not an absolute local path gives way to the default.
  it.each([
    ["an absolute path", { SystemRoot: "D:\\WinNT" }, "D:\\WinNT"],
    ["an absolute path with forward slashes", { SystemRoot: "D:/WinNT" }, "D:\\WinNT"],
    ["missing", {}, "C:\\Windows"],
    ["empty", { SystemRoot: "" }, "C:\\Windows"],
    ["relative", { SystemRoot: "Windows" }, "C:\\Windows"],
    ["relative to a drive's directory", { SystemRoot: "D:Windows" }, "C:\\Windows"],
    ["a network share", { SystemRoot: "\\\\server\\share\\Windows" }, "C:\\Windows"],
    ["cut by a NUL", { SystemRoot: "D:\\WinNT\0" }, "C:\\Windows"],
  ])("runs the system taskkill when SystemRoot is %s, never one found on PATH", async (_case, environment, root) => {
    const taskkill = new EventEmitter()
    const run = vi.fn((_command: string, _args: string[], _options: object) => taskkill as ChildProcess)
    const killing = windowsTreeKill(4_242, run, { ...environment, PATH: "C:\\project;C:\\tools" })
    taskkill.emit("exit", 0, null)
    await killing

    expect(run).toHaveBeenCalledOnce()
    const [command, args, options] = run.mock.calls[0]!
    expect(command).toBe(`${root}\\System32\\taskkill.exe`)
    expect(args).toEqual(["/PID", "4242", "/T", "/F"])
    expect(options).toEqual({ cwd: `${root}\\System32`, windowsHide: true, shell: false, stdio: "ignore" })
  })

  // Review round 2 of #647, R2-F1: this used to settle as a success.
  it("fails when taskkill cannot start", async () => {
    const taskkill = new EventEmitter()
    const killing = windowsTreeKill(4_242, () => taskkill as ChildProcess)
    taskkill.emit("error", new Error("spawn taskkill ENOENT"))
    await expect(killing).rejects.toThrow("taskkill could not start")
  })

  // Q106: once Claude has exited on its own, taskkill /T can no longer find
  // the processes it started, so the tree kill comes first, before any grace
  // and before Claude's input closes. Claude gets no grace to flush on Windows.
  it("kills Claude's tree as the stop begins, then closes its input, and fails after the kill grace", async () => {
    const fake = fakeClaudeChild({ exitsOnEof: false })
    const seen: Array<{ at: number; exited: boolean; inputOpen: boolean }> = []
    const killTree = vi.fn(async (_pid: number) => {
      seen.push({
        at: Date.now(),
        exited: fake.child.exitCode !== null || fake.child.signalCode !== null,
        inputOpen: !fake.child.stdin.writableEnded,
      })
    })
    const { factory } = spawningClaudeFactory()
    const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
      spawn: () => fake.process, killTree, platform: "win32",
    })
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime })

    vi.useFakeTimers()
    try {
      const began = Date.now()
      let outcome: string | undefined
      void adapter.stopThread(threadId).then(
        () => { outcome = "resolved" },
        (error: unknown) => { outcome = error instanceof Error ? error.message : "rejected" },
      )
      await vi.advanceTimersByTimeAsync(1_999)
      expect(killTree.mock.calls).toEqual([[fakeClaudePid]])
      expect(seen).toEqual([{ at: began, exited: false, inputOpen: true }])
      // Once taskkill has finished: Node's own handle, then the input.
      expect(fake.child.kill).toHaveBeenCalledWith("SIGKILL")
      expect(fake.child.stdin.writableEnded).toBe(true)
      // Windows has no keeper and no group: nothing goes on a control pipe.
      expect(fake.commands).toEqual([])

      await vi.advanceTimersByTimeAsync(3_000)
      expect(outcome).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(outcome).toContain("did not exit")
      expect(killTree).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      fake.exit("SIGKILL")
      await adapter.close().catch(() => {})
    }
  })

  it("kills Claude's tree, and waits for taskkill before the stop settles", async () => {
    const fake = fakeClaudeChild({ exitsOnEof: false })
    let finish: (() => void) | undefined
    const killTree = vi.fn((_pid: number) => new Promise<void>((resolve) => {
      finish = () => {
        fake.exit("SIGKILL")
        resolve()
      }
    }))
    const { factory } = spawningClaudeFactory()
    const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
      spawn: () => fake.process, killTree, platform: "win32", shutdownGraceMs: 20,
    })
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime })

    let stopped = false
    const stopping = adapter.stopThread(threadId).then(() => { stopped = true })
    await waitForDaemon(() => expect(killTree).toHaveBeenCalledWith(fakeClaudePid))
    expect(stopped).toBe(false)
    expect(fake.commands).toEqual([])

    finish!()
    await stopping
    expect(killTree).toHaveBeenCalledOnce()
    await adapter.close()
  })

  it("kills Claude's tree before its input closes, though Claude would then exit on its own", async () => {
    const fake = fakeClaudeChild()
    const inputOpen: boolean[] = []
    const killTree = vi.fn(async (_pid: number) => { inputOpen.push(!fake.child.stdin.writableEnded) })
    const { factory } = spawningClaudeFactory()
    const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
      spawn: () => fake.process, killTree, platform: "win32",
    })
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime })

    await adapter.stopThread(threadId)

    expect(killTree.mock.calls).toEqual([[fakeClaudePid]])
    expect(inputOpen).toEqual([true])
    expect(fake.child.exitCode).toBe(0)
    await adapter.close()
  })

})

describe("the POSIX process group kill", () => {
  // The keeper kills the group as Claude exits (see claudeKeeperSource, and
  // the real-process tests below): Domovoi sends it nothing then, or after.
  it("leaves the group kill to the keeper when Claude exits on its own within the grace, and sends nothing after", async () => {
    const fake = fakeClaudeChild()
    const { factory } = spawningClaudeFactory()
    const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
      spawn: () => fake.process, platform: "linux",
    })
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime })
    const spawned = [{ spawn: expect.objectContaining({ command: "/opt/claude/bin/claude" }) }]

    await adapter.stopThread(threadId)

    expect(fake.child.exitCode).toBe(0)
    expect(fake.commands).toEqual(spawned)
    await adapter.stopThread(threadId)
    await adapter.close()
    expect(fake.commands).toEqual(spawned)
  })
})

// Runs on every platform: on Windows the tree kill has to reach the tool too.
it("leaves no tool running when Claude would exit on its own within the grace", async () => {
  const path = await script([
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "const tool = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })",
    "writeFileSync(process.argv[2], String(tool.pid))",
    "process.stdin.resume()",
    "process.stdin.on('end', () => process.exit(0))",
  ].join("\n"))
  const pidFile = join(dirname(path), "tool.pid")
  const { calls, factory } = spawningClaudeFactory(process.execPath, [path, pidFile])
  const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, { spawn: realSpawn })
  const threadId = await adapter.startThread({ cwd: dirname(path), runtime })
  const toolPid = await waitForDaemon(async () => {
    const pid = Number(await readFile(pidFile, "utf8"))
    expect(pid).toBeGreaterThan(0)
    return pid
  })
  tools.push(toolPid)

  await adapter.stopThread(threadId)

  // Q106: on Windows the tree kill comes before the input closes, so Claude
  // does not get to exit on its own. The exit is the one the SDK sees.
  await waitForDaemon(() => expect(calls[0]!.query.process?.exitCode).not.toBeNull())
  if (process.platform === "win32") expect(calls[0]!.query.process?.exitCode).not.toBe(0)
  else expect(calls[0]!.query.process?.exitCode).toBe(0)
  await waitForDaemon(() => expect(() => process.kill(toolPid, 0)).toThrow())
  await adapter.close()
})

describe("the running Claude processes", () => {
  it("lists each live Claude process with its pid and session until it exits", async () => {
    const stuck = fakeClaudeChild({ exitsOnEof: false })
    const { factory } = spawningClaudeFactory()
    const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
      spawn: () => stuck.process, platform: "linux", shutdownGraceMs: 20, killGraceMs: 20,
    })
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime })
    await expect(adapter.close()).rejects.toThrow("did not exit")

    const running = runningClaudeProcesses()
    expect(running).toEqual([expect.objectContaining({ pid: fakeClaudePid, session: threadId })])

    stuck.exit("SIGKILL")
    await running[0]!.exited
    expect(runningClaudeProcesses()).toEqual([])
    await adapter.close()
  })
})

// Security review round 2 of #647.
const unconfirmed = "could not confirm that every process it started has exited"

function killError(code: "EPERM" | "ESRCH"): Error {
  return Object.assign(new Error(`kill ${code}`), { code, syscall: "kill" })
}

// R2-F1: a group kill that fails, or whose processes have not been seen to
// die, left the stop, the adapter's close and the process list to report
// success once Claude itself had exited.
describe("a stop whose tools cannot be seen to exit", () => {
  it("fails, and keeps Claude listed, when its group refuses the kill after Claude exits on its own", async () => {
    const fake = fakeClaudeChild()
    let tool = true
    // A tool that changed its credentials: signals to the group are refused.
    const probe = vi.fn((_pid: number) => { throw killError(tool ? "EPERM" : "ESRCH") })
    const { factory } = spawningClaudeFactory()
    const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
      spawn: () => fake.process,
      probe,
      platform: "linux",
      shutdownGraceMs: 20,
      killGraceMs: 20,
    })
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime })

    await expect(adapter.stopThread(threadId)).rejects.toThrow(unconfirmed)
    expect(fake.child.exitCode).toBe(0)
    expect(runningClaudeProcesses()).toEqual([expect.objectContaining({ pid: fakeClaudePid, session: threadId })])
    await expect(adapter.stopThread(threadId)).rejects.toThrow(unconfirmed)
    await expect(adapter.resumeThread({ threadId, cwd: "/worktree", runtime })).rejects.toThrow(unconfirmed)
    await expect(adapter.close()).rejects.toThrow(unconfirmed)

    tool = false
    await waitForDaemon(() => expect(runningClaudeProcesses()).toEqual([]))
    await adapter.stopThread(threadId)
    await adapter.close()
  })

  it("fails, and keeps Claude listed, when the group kill was sent but its processes have not been seen to die", async () => {
    const fake = fakeClaudeChild({ exitsOnEof: false, killable: true })
    let tool = true
    // Signal 0 still reaches a process in the group.
    const probe = vi.fn((_pid: number) => { if (!tool) throw killError("ESRCH") })
    const { factory } = spawningClaudeFactory()
    const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
      spawn: () => fake.process,
      probe,
      platform: "linux",
      shutdownGraceMs: 20,
      killGraceMs: 20,
    })
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime })

    await expect(adapter.stopThread(threadId)).rejects.toThrow(unconfirmed)
    expect(fake.commands).toContainEqual({ kill: true })
    expect(fake.child.signalCode).toBe("SIGKILL")
    expect(runningClaudeProcesses()).toEqual([expect.objectContaining({ pid: fakeClaudePid, session: threadId })])
    await expect(adapter.close()).rejects.toThrow(unconfirmed)

    tool = false
    await waitForDaemon(() => expect(runningClaudeProcesses()).toEqual([]))
    await adapter.close()
  })

  it("rejects a taskkill that exits nonzero, or cannot start", async () => {
    const failing = new EventEmitter()
    const failed = windowsTreeKill(4_242, () => failing as ChildProcess)
    failing.emit("exit", 1, null)
    await expect(failed).rejects.toThrow("taskkill")

    const missing = new EventEmitter()
    const unstarted = windowsTreeKill(4_242, () => missing as ChildProcess)
    missing.emit("error", new Error("spawn taskkill ENOENT"))
    await expect(unstarted).rejects.toThrow("taskkill")
  })
})

// R2-F2: the group kill as Claude exited named the group by number, after
// Node had reaped Claude, when that number could already name another group.
it("signals no process group by number, and still leaves no tool running when Claude exits on its own", async () => {
  const path = await script([
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "const tool = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })",
    "writeFileSync(process.argv[2], String(tool.pid))",
    "process.stdin.resume()",
    "process.stdin.on('end', () => process.exit(0))",
  ].join("\n"))
  const pidFile = join(dirname(path), "tool.pid")
  const { factory } = spawningClaudeFactory(process.execPath, [path, pidFile])
  const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, { spawn: realSpawn })
  const threadId = await adapter.startThread({ cwd: dirname(path), runtime })
  const toolPid = await waitForDaemon(async () => {
    const pid = Number(await readFile(pidFile, "utf8"))
    expect(pid).toBeGreaterThan(0)
    return pid
  })
  tools.push(toolPid)
  const signals = vi.spyOn(process, "kill")
  const calls: Array<Parameters<typeof process.kill>> = []

  try {
    await adapter.stopThread(threadId)
    await waitForDaemon(() => expect(() => process.kill(toolPid, 0)).toThrow())
  } finally {
    calls.push(...signals.mock.calls)
    signals.mockRestore()
  }
  expect(calls.filter(([pid, signal]) => pid < 0 && signal !== 0 && signal !== undefined)).toEqual([])
  await adapter.close()
})

// Review round 3 of #647, R3-F2: a keeper killed on its own counted as
// Claude's exit, and left Domovoi no way to end Claude's group, since only the
// keeper could.
describe("a keeper killed while Claude runs", () => {
  const options = {
    command: "/opt/claude/bin/claude", args: [], env: { PATH: "/usr/bin" }, signal: new AbortController().signal,
  }

  it("leaves Claude running and listed, and a stop ends its group through the sentinel", async () => {
    const fake = fakeClaudeChild({ exitsOnEof: false, killable: true })
    let members = true
    const probe = vi.fn((_pid: number) => { if (!members) throw killError("ESRCH") })
    const claude = spawnClaudeProcess(options, () => {}, { spawn: () => fake.process, probe, platform: "linux" }, "kept")
    const exits: unknown[] = []
    claude.spawned.once("exit", (...status: unknown[]) => exits.push(status))

    try {
      fake.crash()
      await new Promise((resolve) => { setTimeout(resolve, 120) })
      expect(claude.claudeHasExited()).toBe(false)
      expect(claude.hasExited()).toBe(false)
      expect(exits).toEqual([])
      expect(runningClaudeProcesses()).toContainEqual(expect.objectContaining({ pid: fakeClaudePid, session: "kept" }))

      let stopped = false
      const stopping = stopClaudeProcess(claude, () => fake.child.stdin.end(), {
        platform: "linux", shutdownGraceMs: 20, killGraceMs: 1_000,
      }).then(() => { stopped = true })
      await waitForDaemon(() => expect(fake.sentinel).toEqual(["kill\n"]))
      // Claude has gone, but the group is not yet seen empty.
      await waitForDaemon(() => expect(fake.child.stdout.writableEnded).toBe(true))
      await new Promise((resolve) => { setTimeout(resolve, 60) })
      expect(stopped).toBe(false)
      expect(claude.hasExited()).toBe(false)
      expect(runningClaudeProcesses()).toContainEqual(expect.objectContaining({ pid: fakeClaudePid, session: "kept" }))

      members = false
      await stopping
      expect(claude.hasExited()).toBe(true)
      expect(claude.claudeHasExited()).toBe(true)
      expect(runningClaudeProcesses()).not.toContainEqual(expect.objectContaining({ pid: fakeClaudePid, session: "kept" }))
      // Nothing went to the dead keeper.
      expect(fake.commands).toEqual([{ spawn: { command: options.command, args: [], env: options.env } }])
      await waitForDaemon(() => expect(exits).toHaveLength(1))
    } finally {
      members = false
      fake.exit("SIGKILL")
      await claude.exited
    }
  })

  // The SDK's own close sends SIGTERM, then SIGKILL.
  it("ends the group through the sentinel for the SDK's SIGKILL, and passes on nothing else, once the keeper has gone", async () => {
    const fake = fakeClaudeChild({ exitsOnEof: false })
    let members = true
    const probe = vi.fn((_pid: number) => { if (!members) throw killError("ESRCH") })
    const claude = spawnClaudeProcess(options, () => {}, { spawn: () => fake.process, probe, platform: "linux" }, "sdk kill")
    try {
      fake.crash()
      expect(claude.spawned.kill("SIGTERM")).toBe(false)
      expect(fake.sentinel).toEqual([])
      expect(claude.spawned.kill("SIGKILL")).toBe(true)
      expect(claude.spawned.killed).toBe(true)
      expect(fake.sentinel).toEqual(["kill\n"])
      expect(fake.commands).toEqual([{ spawn: { command: options.command, args: [], env: options.env } }])
    } finally {
      members = false
      fake.exit("SIGKILL")
      await claude.exited
    }
  })

  it("fails the stop, and keeps Claude listed, when the sentinel has gone too", async () => {
    const fake = fakeClaudeChild({ exitsOnEof: false })
    let members = true
    const probe = vi.fn((_pid: number) => { if (!members) throw killError("ESRCH") })
    const claude = spawnClaudeProcess(options, () => {}, { spawn: () => fake.process, probe, platform: "linux" }, "orphaned")
    try {
      fake.crash()
      // The sentinel's end of its pipe closes as it dies.
      ;(fake.process.stdio as unknown as PassThrough[])[4]!.push(null)

      await expect(stopClaudeProcess(claude, () => fake.child.stdin.end(), {
        platform: "linux", shutdownGraceMs: 20, killGraceMs: 20,
      })).rejects.toThrow("did not exit")
      expect(runningClaudeProcesses()).toContainEqual(expect.objectContaining({ pid: fakeClaudePid, session: "orphaned" }))

      members = false
      await claude.exited
      expect(runningClaudeProcesses()).not.toContainEqual(expect.objectContaining({ session: "orphaned" }))
    } finally {
      members = false
      fake.exit("SIGKILL")
      await claude.exited
    }
  })

  // With real processes: the keeper is sent SIGKILL, and Claude, a real Node
  // process that ignores the end of its input, runs on.
  it.skipIf(process.platform === "win32")("ends a real Claude that ignores its input's end once its keeper was killed, and sees its group empty", async () => {
    const path = await script([
      "import { writeFileSync } from 'node:fs'",
      "writeFileSync(process.argv[2], String(process.pid))",
      "process.stdin.resume()",
      "setInterval(() => {}, 1000)",
    ].join("\n"))
    const pidFile = join(dirname(path), "claude.pid")
    const claude = spawnClaudeProcess({
      command: process.execPath, args: [path, pidFile], cwd: dirname(path), env: { PATH: "/usr/bin:/bin" },
      signal: new AbortController().signal,
    }, () => {}, { spawn: realSpawn }, "real keeper")
    const keeper = started.at(-1)!
    const claudePid = await waitForDaemon(async () => {
      const pid = Number(await readFile(pidFile, "utf8"))
      expect(pid).toBeGreaterThan(0)
      return pid
    })
    tools.push(claudePid)

    try {
      process.kill(keeper.pid!, "SIGKILL")
      await waitForDaemon(() => expect(keeper.signalCode).toBe("SIGKILL"))
      await new Promise((resolve) => { setTimeout(resolve, 150) })
      expect(() => process.kill(claudePid, 0)).not.toThrow()
      expect(claude.claudeHasExited()).toBe(false)
      expect(claude.hasExited()).toBe(false)
      expect(runningClaudeProcesses()).toContainEqual(expect.objectContaining({ pid: keeper.pid, session: "real keeper" }))

      await stopClaudeProcess(claude, () => claude.spawned.stdin.end(), { shutdownGraceMs: 20 })

      expect(claude.hasExited()).toBe(true)
      expect(() => process.kill(claudePid, 0)).toThrow()
      // Signal 0 only: the group's number may name another group by now.
      expect(() => process.kill(-keeper.pid!, 0)).toThrow()
      expect(runningClaudeProcesses()).not.toContainEqual(expect.objectContaining({ session: "real keeper" }))
    } finally {
      // Through the sentinel, so a failure above leaves nothing of the group.
      await claude.kill().catch(() => {})
    }
  })
})

// R2-F3: an overlapping close that failed reopened the adapter after another
// close had succeeded, and the next start spawned Claude.
it("stays closed after overlapping closes when one of them succeeded", async () => {
  const stuck = fakeClaudeChild({ exitsOnEof: false })
  const spawn = vi.fn<ClaudeSpawn>(() => stuck.process)
  const { factory } = spawningClaudeFactory()
  const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
    spawn, platform: "linux", shutdownGraceMs: 20, killGraceMs: 20,
  })
  const threadId = await adapter.startThread({ cwd: "/worktree", runtime })
  await expect(adapter.stopThread(threadId)).rejects.toThrow("did not exit")

  const first = adapter.close()
  queueMicrotask(() => stuck.exit("SIGKILL"))
  const second = adapter.close()
  const results = await Promise.allSettled([first, second])

  expect(results.map(({ status }) => status)).toContain("fulfilled")
  await expect(adapter.startThread({ cwd: "/worktree", runtime })).rejects.toThrow("Claude adapter is closed")
  expect(spawn).toHaveBeenCalledOnce()
})

// R2-F4: a model list still starting, or still listing, was neither a session
// nor stopping, so close neither stopped it nor waited for its Claude.
describe("a model list that close overtakes", () => {
  function listingAdapter(child: ReturnType<typeof fakeClaudeChild>, phase: "initialization" | "model list") {
    const spawn = vi.fn<ClaudeSpawn>(() => child.process)
    const { calls, factory: spawning } = spawningClaudeFactory()
    let fail: ((error: Error) => void) | undefined
    const factory: ClaudeQueryFactory = (input, options) => {
      const query = spawning(input, options) as FakeClaudeQuery
      const pending = new Promise<never>((_resolve, reject) => { fail = reject })
      if (phase === "initialization") query.initializationResult = () => pending
      else query.supportedModels = () => pending
      return query
    }
    const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
      spawn, platform: "linux", shutdownGraceMs: 20, killGraceMs: 20,
    })
    const listing = adapter.listModels().then(() => "listed", () => "failed")
    // As the SDK does, a closed query's pending request fails.
    const failPending = () => fail?.(new Error("Claude Code query closed"))
    return { adapter, spawn, calls, listing, failPending }
  }

  it.each(["initialization", "model list"] as const)("stops it and waits for its Claude while its %s is pending", async (phase) => {
    const child = fakeClaudeChild()
    const { adapter, spawn, calls, listing, failPending } = listingAdapter(child, phase)
    await waitForDaemon(() => expect(spawn).toHaveBeenCalledOnce())
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    await adapter.close()

    expect(calls[0]!.query.close).toHaveBeenCalled()
    expect(child.child.exitCode).toBe(0)
    expect(runningClaudeProcesses()).toEqual([])
    failPending()
    expect(await listing).toBe("failed")
  })

  it("fails close while that Claude will not exit, and succeeds once it has", async () => {
    const stuck = fakeClaudeChild({ exitsOnEof: false })
    const { adapter, spawn, listing, failPending } = listingAdapter(stuck, "initialization")
    await waitForDaemon(() => expect(spawn).toHaveBeenCalledOnce())

    await expect(adapter.close()).rejects.toThrow("did not exit")
    expect(runningClaudeProcesses()).toEqual([expect.objectContaining({ pid: fakeClaudePid })])

    stuck.exit("SIGKILL")
    failPending()
    expect(await listing).toBe("failed")
    await adapter.close()
    expect(runningClaudeProcesses()).toEqual([])
  })
})

// R2-F2: what the SDK sees of the process it asked for, whatever Domovoi
// starts to hold Claude's process group. On Windows a Claude that exits
// without a stop's tree kill stays listed for the life of the daemon (Q111),
// so these come after every test that expects no Claude listed.
describe("the Claude process the SDK sees", () => {
  const environment = { PATH: "/usr/bin:/bin", DOMOVOI_KEEPER_MARKER: "kept" }
  const windowsRequiredVariables = new Set([
    "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME",
    "USERPROFILE", "WINDIR",
  ])
  // Windows has no signal a process can handle: Node ends it outright.
  const handlesSignals = process.platform !== "win32"

  // Waits for Claude's own end. On POSIX its whole group is then seen gone.
  // On Windows nothing is: no stop killed its tree while it ran, so what it
  // started stays unconfirmed (Q111).
  async function ended(claude: ClaudeProcess): Promise<void> {
    if (process.platform !== "win32") {
      await claude.exited
      return
    }
    await waitForDaemon(() => expect(claude.claudeHasExited()).toBe(true))
    expect(claude.hasExited()).toBe(false)
  }

  async function start(lines: string[], { command = process.execPath, signal = new AbortController().signal } = {}) {
    const path = await script([
      "import { fstatSync, writeFileSync } from 'node:fs'",
      "import { join, dirname } from 'node:path'",
      "const here = dirname(process.argv[1])",
      "const kind = (fd) => { try { const s = fstatSync(fd); return s.isSocket() ? 'socket' : s.isFIFO() ? 'pipe' : s.isCharacterDevice() ? 'device' : 'file' } catch (error) { return error.code } }",
      "const fd3 = kind(3)",
      "const fd4 = kind(4)",
      "writeFileSync(join(here, 'seen.json'), JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), keys: Object.keys(process.env).sort(), marker: process.env.DOMOVOI_KEEPER_MARKER, fd3, fd4 }))",
      ...lines,
    ].join("\n"))
    const directory = dirname(path)
    const stderr: string[] = []
    const claude = spawnClaudeProcess({
      command, args: command === process.execPath ? [path, "first argument", "--flag=two"] : ["one"],
      cwd: directory, env: environment, signal,
    }, (text) => stderr.push(text), { spawn: realSpawn })
    const exits: Array<[number | null, NodeJS.Signals | null]> = []
    claude.spawned.once("exit", (code: number | null, exitSignal: NodeJS.Signals | null) => exits.push([code, exitSignal]))
    const errors: Error[] = []
    claude.spawned.on("error", (error: Error) => errors.push(error))
    const seen = () => waitForDaemon(async () => {
      const value = JSON.parse(await readFile(join(directory, "seen.json"), "utf8")) as {
        pid: number; argv: string[]; cwd: string; keys: string[]; marker: string; fd3: string; fd4: string
      }
      tools.push(value.pid)
      return value
    })
    return { claude, directory, stderr, exits, errors, seen }
  }

  it("gets the SDK's arguments, directory and environment, its stdio, and its exit code", async () => {
    const { claude, directory, stderr, exits, seen } = await start([
      "process.stderr.write('café\\n')",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (text) => process.stdout.write(text.toUpperCase()))",
      "process.stdin.on('end', () => process.exit(7))",
    ])
    const view = await seen()
    expect(view.argv).toEqual(["first argument", "--flag=two"])
    expect(view.cwd).toBe(await realpath(directory))
    // macOS adds __CF_USER_TEXT_ENCODING to every process it starts, and on
    // Windows libuv copies the variables a Windows process needs.
    const added = (key: string) => key.startsWith("__CF_")
      || (process.platform === "win32" && windowsRequiredVariables.has(key.toUpperCase()))
    expect(view.keys.filter((key) => !added(key))).toEqual(["DOMOVOI_KEEPER_MARKER", "PATH"])
    expect(view.marker).toBe("kept")
    // No pipe to Domovoi beyond stdio reaches Claude or its tools: neither
    // the keeper's control pipe nor the sentinel's, both sockets. Node itself
    // may hold a pipe of its own at fd 4.
    expect(["socket", "pipe"]).not.toContain(view.fd3)
    expect(view.fd4).not.toBe("socket")

    const output: string[] = []
    claude.spawned.stdout.setEncoding("utf8")
    claude.spawned.stdout.on("data", (text: string) => output.push(text))
    claude.spawned.stdin.write("hello\n")
    await waitForDaemon(() => expect(output.join("")).toBe("HELLO\n"))
    claude.spawned.stdin.end()
    await ended(claude)

    await waitForDaemon(() => expect(exits).toEqual([[7, null]]))
    expect(claude.spawned.exitCode).toBe(7)
    expect(claude.spawned.signalCode).toBeNull()
    expect(claude.spawned.killed).toBe(false)
    expect(stderr.join("")).toBe("café\n")
  })

  it("forwards a signal the SDK sends to Claude", async () => {
    const { claude, directory, exits, seen } = await start([
      "process.on('SIGTERM', () => { writeFileSync(join(here, 'term'), 'yes'); process.exit(3) })",
      "process.stdin.resume()",
      "setInterval(() => {}, 1000)",
    ])
    await seen()
    expect(claude.spawned.kill("SIGTERM")).toBe(true)
    await ended(claude)
    expect(claude.spawned.killed).toBe(true)
    if (handlesSignals) {
      await waitForDaemon(() => expect(exits).toEqual([[3, null]]))
      expect(await readFile(join(directory, "term"), "utf8")).toBe("yes")
    } else {
      await waitForDaemon(() => expect(exits).toEqual([[null, "SIGTERM"]]))
    }
  })

  it("reports Claude killed by a signal", async () => {
    const { claude, exits, seen } = await start(["process.stdin.resume()", "setInterval(() => {}, 1000)"])
    await seen()
    claude.spawned.kill("SIGKILL")
    await ended(claude)
    await waitForDaemon(() => expect(exits).toEqual([[null, "SIGKILL"]]))
    expect(claude.spawned.signalCode).toBe("SIGKILL")
  })

  it("forwards the SDK's abort to Claude as SIGTERM, with the abort error", async () => {
    const controller = new AbortController()
    const { claude, directory, errors, seen } = await start([
      "process.on('SIGTERM', () => { writeFileSync(join(here, 'term'), 'yes'); process.exit(0) })",
      "process.stdin.resume()",
      "setInterval(() => {}, 1000)",
    ], { signal: controller.signal })
    await seen()
    controller.abort()
    await ended(claude)
    expect(errors.map(({ name }) => name)).toEqual(["AbortError"])
    if (handlesSignals) expect(await readFile(join(directory, "term"), "utf8")).toBe("yes")
  })

  it("reports a Claude that cannot start as the spawn error the SDK expects", async () => {
    const missing = join(tmpdir(), "domovoi-no-such-claude", "claude")
    const { claude, errors } = await start([], { command: missing })
    // A Claude that never started has nothing to wait for, on any platform.
    await claude.exited
    await waitForDaemon(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toMatchObject({ code: "ENOENT", syscall: `spawn ${missing}`, path: missing })
  })
})

// R2-F1 on Windows: a taskkill that fails cannot be retried once Claude has
// exited, since its pid may then name another process, so the stop stays
// failed and Claude stays listed for the life of the daemon. Last in this file
// for that reason.
it.each([
  ["cannot start", 99, (taskkill: EventEmitter) => taskkill.emit("error", new Error("spawn taskkill ENOENT"))],
  ["exits nonzero", 98, (taskkill: EventEmitter) => taskkill.emit("exit", 1, null)],
] as const)("fails a Windows stop, and keeps Claude listed, when taskkill %s, though Claude itself is then killed", async (_case, offset, fail) => {
  const pid = fakeClaudePid + offset
  const fake = fakeClaudeChild({ exitsOnEof: false, pid })
  fake.child.kill.mockImplementation((signal) => {
    if (signal === "SIGKILL") setImmediate(() => fake.exit("SIGKILL"))
    return true
  })
  const run = vi.fn(() => {
    const taskkill = new EventEmitter()
    setImmediate(() => fail(taskkill))
    return taskkill as ChildProcess
  })
  const killTree = vi.fn((target: number) => windowsTreeKill(target, run))
  const { factory } = spawningClaudeFactory()
  const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
    spawn: () => fake.process, killTree, platform: "win32", shutdownGraceMs: 20, killGraceMs: 20,
  })
  const threadId = await adapter.startThread({ cwd: "/worktree", runtime })

  await expect(adapter.stopThread(threadId)).rejects.toThrow(unconfirmed)
  expect(fake.child.signalCode).toBe("SIGKILL")
  expect(killTree.mock.calls).toEqual([[pid]])
  expect(runningClaudeProcesses()).toContainEqual(expect.objectContaining({ pid, session: threadId }))
  await expect(adapter.stopThread(threadId)).rejects.toThrow(unconfirmed)
  await expect(adapter.close()).rejects.toThrow(unconfirmed)
  // Claude's pid may name another process now: no second taskkill.
  expect(run).toHaveBeenCalledOnce()
})

// Q111 B, security review round 4 of #647: a Windows Claude that exits on its
// own, before any stop, leaves what it started unconfirmed. Domovoi lists no
// process and kills none, since a pid found by a list may name any process by
// the time it is killed. The stop fails, and Claude stays listed for the life
// of the daemon, so this comes last too.
it("fails a Windows stop, and starts no command, when Claude exited on its own before it", async () => {
  const pid = fakeClaudePid + 95
  const fake = fakeClaudeChild({ pid })
  const killTree = vi.fn(async (_pid: number) => {})
  const { factory } = spawningClaudeFactory()
  const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
    spawn: () => fake.process, killTree, platform: "win32", shutdownGraceMs: 20, killGraceMs: 20,
  })
  const threadId = await adapter.startThread({ cwd: "/worktree", runtime })
  launched.splice(0)
  fake.exit()
  await new Promise((resolve) => { setTimeout(resolve, 50) })

  await expect(adapter.stopThread(threadId)).rejects.toThrow(unconfirmed)
  expect(runningClaudeProcesses()).toContainEqual(expect.objectContaining({ pid, session: threadId }))
  await expect(adapter.stopThread(threadId)).rejects.toThrow(unconfirmed)
  await expect(adapter.resumeThread({ threadId, cwd: "/worktree", runtime })).rejects.toThrow(unconfirmed)
  await expect(adapter.close()).rejects.toThrow(unconfirmed)
  // No list, no taskkill and no kill through Node's handle to Claude.
  expect(launched).toEqual([])
  expect(killTree).not.toHaveBeenCalled()
  expect(fake.child.kill).not.toHaveBeenCalled()
  expect(fake.commands).toEqual([])
  expect(runningClaudeProcesses()).toContainEqual(expect.objectContaining({ pid, session: threadId }))
})
