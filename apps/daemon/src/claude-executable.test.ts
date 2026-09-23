import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Runtime } from "@getdomovoi/protocol"

const sdk = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }))

const { ClaudeAgentSdkAdapter } = await import("./claude.js")

const runtime: Runtime = {
  provider: "claude-code",
  model: "sonnet",
  reasoning: "high",
  permissionMode: "build",
  auto: false,
}

function fakeQuery() {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    initializationResult: vi.fn(async () => ({})),
    supportedModels: vi.fn(async () => [{
      value: "sonnet",
      displayName: "Sonnet 5",
      description: "Balanced coding model",
    }]),
    getContextUsage: vi.fn(async () => ({})),
    setModel: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(),
  }
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "domovoi-claude-path-"))
  vi.stubEnv("PATH", directory)
  sdk.query.mockReset()
  sdk.query.mockImplementation(() => fakeQuery())
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

describe("the Claude executable", () => {
  it("runs the person's own claude from PATH", async () => {
    const executable = join(directory, process.platform === "win32" ? "claude.exe" : "claude")
    await writeFile(executable, "#!/bin/sh\n")
    await chmod(executable, 0o755)
    const adapter = new ClaudeAgentSdkAdapter()

    await adapter.listModels()
    await adapter.startThread({ cwd: directory, runtime })
    await adapter.resumeThread({ threadId: "11111111-1111-4111-8111-111111111111", cwd: directory, runtime })

    expect(sdk.query).toHaveBeenCalledTimes(3)
    for (const [call] of sdk.query.mock.calls) {
      expect(call.options.pathToClaudeCodeExecutable).toBe(executable)
    }
    await adapter.close()
  })

  it("refuses to start without an installed claude", async () => {
    const adapter = new ClaudeAgentSdkAdapter()

    await expect(adapter.listModels()).rejects.toThrow("Claude Code is not installed")
    await expect(adapter.startThread({ cwd: directory, runtime }))
      .rejects.toThrow("Claude Code is not installed")
    await expect(adapter.resumeThread({ threadId: "11111111-1111-4111-8111-111111111111", cwd: directory, runtime }))
      .rejects.toThrow("Claude Code is not installed")
    expect(sdk.query).not.toHaveBeenCalled()
  })

  it.runIf(process.platform !== "win32")("refuses a claude older than the SDK needs, with the version to install", async () => {
    const executable = join(directory, "claude")
    await writeFile(executable, "#!/bin/sh\necho '2.1.100 (Claude Code)'\n")
    await chmod(executable, 0o755)
    const adapter = new ClaudeAgentSdkAdapter()

    await expect(adapter.startThread({ cwd: directory, runtime }))
      .rejects.toThrow("Update Claude Code to 2.1.263 or newer. The claude on this machine is 2.1.100.")
    await expect(adapter.resumeThread({ threadId: "11111111-1111-4111-8111-111111111111", cwd: directory, runtime }))
      .rejects.toThrow("Update Claude Code to 2.1.263 or newer")
    expect(sdk.query).not.toHaveBeenCalled()
  })
})
