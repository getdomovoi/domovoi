import { describe, expect, it, vi } from "vitest"

import { CliProviderProbe, type CommandResult, type ProviderCommandRunner } from "./providers.js"

describe("CliProviderProbe", () => {
  it("reports versions and known authentication states without exposing account data", async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      const key = `${command} ${args.join(" ")}`
      if (key === "claude --version") return { exitCode: 0, stdout: "2.1.247 (Claude Code)\n", stderr: "" }
      if (key === "claude auth status") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "secret@example.com" }),
          stderr: "",
        }
      }
      if (key === "codex --version") return { exitCode: 0, stdout: "codex-cli 0.149.0\n", stderr: "" }
      if (key === "codex login status") return { exitCode: 0, stdout: "Logged in using ChatGPT\n", stderr: "" }
      throw Object.assign(new Error("missing"), { code: "ENOENT" })
    }) satisfies ProviderCommandRunner

    const providers = await new CliProviderProbe(run).inspect()

    expect(providers).toEqual(expect.arrayContaining([
      { id: "claude-code", command: "claude", status: "ready", version: "2.1.247" },
      { id: "codex", command: "codex", status: "ready", version: "0.149.0" },
      { id: "opencode", command: "opencode", status: "missing" },
    ]))
    expect(JSON.stringify(providers)).not.toContain("secret@example.com")
  })

  it("separates missing binaries, expired login, and unknown authentication", async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      if (command === "claude" && args[0] === "--version") {
        return { exitCode: 0, stdout: "2.1.247 (Claude Code)", stderr: "" }
      }
      if (command === "claude") {
        return { exitCode: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "login required" }
      }
      if (command === "kilo" && args[0] === "--version") {
        return { exitCode: 0, stdout: "kilo 1.2.0", stderr: "" }
      }
      if (command === "codex" && args[0] === "--version") {
        return { exitCode: 0, stdout: "codex-cli 0.149.0", stderr: "" }
      }
      if (command === "codex") {
        return { exitCode: 1, stdout: "Not logged in", stderr: "" }
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" })
    }) satisfies ProviderCommandRunner

    const providers = await new CliProviderProbe(run).inspect()

    expect(providers.find((provider) => provider.id === "claude-code")).toMatchObject({
      status: "auth-required",
    })
    expect(providers.find((provider) => provider.id === "kilo")).toEqual({
      id: "kilo",
      command: "kilo",
      status: "unknown",
      version: "1.2.0",
    })
    expect(providers.find((provider) => provider.id === "codex")).toMatchObject({
      status: "auth-required",
    })
  })

  it("prefers the current Cursor binary and probes Cursor and Grok readiness", async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      const key = `${command} ${args.join(" ")}`
      if (key === "agent --version") return { exitCode: 0, stdout: "Cursor Agent 2026.08.1", stderr: "" }
      if (key === "agent status") return { exitCode: 0, stdout: "Logged in", stderr: "" }
      if (key === "grok --version") return { exitCode: 0, stdout: "grok 0.18.0", stderr: "" }
      if (key === "grok models") return { exitCode: 0, stdout: "grok-code-fast-1", stderr: "" }
      throw Object.assign(new Error("missing"), { code: "ENOENT" })
    }) satisfies ProviderCommandRunner

    const providers = await new CliProviderProbe(run).inspect()

    expect(providers.find((provider) => provider.id === "cursor-agent")).toEqual({
      id: "cursor-agent",
      command: "agent",
      status: "ready",
      version: "2026.08.1",
    })
    expect(providers.find((provider) => provider.id === "grok")).toEqual({
      id: "grok",
      command: "grok",
      status: "ready",
      version: "0.18.0",
    })
    expect(run).not.toHaveBeenCalledWith("cursor-agent", expect.anything())
  })

  it("falls back to cursor-agent and reports failed model probes as signed out", async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      const key = `${command} ${args.join(" ")}`
      if (command === "agent") throw Object.assign(new Error("missing"), { code: "ENOENT" })
      if (key === "cursor-agent --version") {
        return { exitCode: 0, stdout: "cursor-agent 1.7.0", stderr: "" }
      }
      if (key === "cursor-agent status") {
        return { exitCode: 1, stdout: "", stderr: "Not logged in" }
      }
      if (key === "grok --version") return { exitCode: 0, stdout: "grok 0.18.0", stderr: "" }
      if (key === "grok models") return { exitCode: 1, stdout: "", stderr: "login required" }
      throw Object.assign(new Error("missing"), { code: "ENOENT" })
    }) satisfies ProviderCommandRunner

    const providers = await new CliProviderProbe(run).inspect()

    expect(providers.find((provider) => provider.id === "cursor-agent")).toMatchObject({
      command: "cursor-agent",
      status: "auth-required",
    })
    expect(providers.find((provider) => provider.id === "grok")).toMatchObject({
      status: "auth-required",
    })
  })
})
