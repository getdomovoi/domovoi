import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { Runtime } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ClaudeAgentSdkAdapter } from "./claude.js"
import { runningClaudeProcesses, windowsTreeKill, type ClaudeSpawn } from "./claude-process.js"
import { fakeClaudeChild, fakeClaudePid, spawningClaudeFactory } from "./test-claude-process.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"

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
  // Only processes these tests started.
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
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
    const killing = windowsTreeKill(4_242, run).then(() => { settled = true })

    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
      { windowsHide: true, shell: false, stdio: "ignore" },
    )
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(settled).toBe(false)

    taskkill.emit("exit", 0, null)
    await killing
    expect(settled).toBe(true)
  })

  it("settles when taskkill cannot start", async () => {
    const taskkill = new EventEmitter()
    const killing = windowsTreeKill(4_242, () => taskkill as ChildProcess)
    taskkill.emit("error", new Error("spawn taskkill ENOENT"))
    await expect(killing).resolves.toBeUndefined()
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
    const kill = vi.fn()
    const { factory } = spawningClaudeFactory()
    const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
      spawn: () => fake.process, kill, killTree, platform: "win32",
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
      expect(kill).not.toHaveBeenCalled()

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
    const kill = vi.fn()
    const { factory } = spawningClaudeFactory()
    const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
      spawn: () => fake.process, kill, killTree, platform: "win32", shutdownGraceMs: 20,
    })
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime })

    let stopped = false
    const stopping = adapter.stopThread(threadId).then(() => { stopped = true })
    await waitForDaemon(() => expect(killTree).toHaveBeenCalledWith(fakeClaudePid))
    expect(stopped).toBe(false)
    expect(kill).not.toHaveBeenCalled()

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
      spawn: () => fake.process, kill: vi.fn(), killTree, platform: "win32",
    })
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime })

    await adapter.stopThread(threadId)

    expect(killTree.mock.calls).toEqual([[fakeClaudePid]])
    expect(inputOpen).toEqual([true])
    expect(fake.child.exitCode).toBe(0)
    await adapter.close()
  })

  it("sends no taskkill for a Claude that exited before the stop began, when its pid may name another process", async () => {
    const fake = fakeClaudeChild()
    const killTree = vi.fn(async (_pid: number) => {})
    const kill = vi.fn()
    const { factory } = spawningClaudeFactory()
    const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
      spawn: () => fake.process, kill, killTree, platform: "win32",
    })
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime })
    fake.exit()

    await adapter.stopThread(threadId)

    expect(fake.child.exitCode).toBe(0)
    expect(killTree).not.toHaveBeenCalled()
    expect(fake.child.kill).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    await adapter.close()
  })
})

describe("the POSIX process group kill", () => {
  it("kills Claude's process group when Claude exits on its own within the grace, and signals nothing after", async () => {
    const fake = fakeClaudeChild()
    const kill = vi.fn()
    const { factory } = spawningClaudeFactory()
    const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
      spawn: () => fake.process, kill, platform: "linux",
    })
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime })

    await adapter.stopThread(threadId)

    expect(fake.child.exitCode).toBe(0)
    expect(kill).toHaveBeenCalledOnce()
    expect(kill).toHaveBeenCalledWith(-fakeClaudePid, "SIGKILL")
    await adapter.stopThread(threadId)
    await adapter.close()
    expect(kill).toHaveBeenCalledOnce()
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
  const { factory } = spawningClaudeFactory(process.execPath, [path, pidFile])
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
  // does not get to exit on its own.
  if (process.platform === "win32") expect(started[0]!.exitCode).not.toBe(0)
  else expect(started[0]!.exitCode).toBe(0)
  await waitForDaemon(() => expect(() => process.kill(toolPid, 0)).toThrow())
  await adapter.close()
})

describe("the running Claude processes", () => {
  it("lists each live Claude process with its pid and session until it exits", async () => {
    const stuck = fakeClaudeChild({ exitsOnEof: false })
    const { factory } = spawningClaudeFactory()
    const adapter = new ClaudeAgentSdkAdapter(factory, undefined, undefined, {
      spawn: () => stuck.process, kill: vi.fn(), platform: "linux", shutdownGraceMs: 20, killGraceMs: 20,
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
