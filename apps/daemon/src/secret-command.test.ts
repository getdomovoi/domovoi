import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"

import type { ProviderSecretStatus } from "./provider-secrets.js"
import { readHiddenSecret, runProviderSecretCommand } from "./secret-command.js"

function manager(status: ProviderSecretStatus[] = []) {
  return {
    status: vi.fn(() => status),
    set: vi.fn(),
    delete: vi.fn(),
  }
}

function fakeTerminal() {
  const events = new EventEmitter()
  const rawModes: boolean[] = []
  const input = Object.assign(events, {
    isTTY: true,
    isRaw: false,
    pause: vi.fn(),
    resume: vi.fn(),
    setRawMode: (enabled: boolean) => { rawModes.push(enabled) },
  })
  const written: string[] = []
  const output = { write: (text: string) => { written.push(text); return true } }
  const read = () => readHiddenSecret(
    input as unknown as Parameters<typeof readHiddenSecret>[0],
    output as unknown as Parameters<typeof readHiddenSecret>[1],
  )
  return { input, output, rawModes, read, written }
}

describe("provider secret CLI", () => {
  it("disables terminal echo while reading the key", async () => {
    const terminal = fakeTerminal()
    const secret = terminal.read()
    terminal.input.emit("data", Buffer.from("sk-hidden\r"))

    await expect(secret).resolves.toBe("sk-hidden")
    expect(terminal.rawModes).toEqual([true, false])
    expect(terminal.written).toEqual(["Provider key: ", "\n"])
    expect(terminal.written.join("")).not.toContain("sk-hidden")
  })

  it.each([
    ["Ctrl-C", (input: EventEmitter) => input.emit("data", Buffer.from("partial-secret\u0003"))],
    ["EOF", (input: EventEmitter) => input.emit("end")],
    ["input error", (input: EventEmitter) => input.emit("error", new Error("partial-secret"))],
  ])("restores terminal state on %s", async (_label, interrupt) => {
    const terminal = fakeTerminal()
    const secret = terminal.read()
    interrupt(terminal.input)

    await expect(secret).rejects.toBeInstanceOf(Error)
    expect(terminal.rawModes).toEqual([true, false])
    expect(terminal.input.pause).toHaveBeenCalledOnce()
    expect(terminal.written.join("")).not.toContain("partial-secret")
  })

  it("sets a key from hidden input and never writes its value", async () => {
    const secrets = manager()
    const stdout = vi.fn()
    const stderr = vi.fn()
    const readSecret = vi.fn(async () => "sk-local-only")

    const code = await runProviderSecretCommand(
      ["secret", "set", "openai"],
      { manager: secrets, readSecret, stdout, stderr },
    )

    expect(code).toBe(0)
    expect(readSecret).toHaveBeenCalledOnce()
    expect(secrets.set).toHaveBeenCalledWith("openai", "sk-local-only")
    expect(stdout).toHaveBeenCalledWith("openai: stored\n")
    expect(JSON.stringify([...stdout.mock.calls, ...stderr.mock.calls])).not.toContain("sk-local-only")
  })

  it("rejects secrets passed through argv without echoing them", async () => {
    const secrets = manager()
    const stdout = vi.fn()
    const stderr = vi.fn()
    const readSecret = vi.fn()

    const code = await runProviderSecretCommand(
      ["secret", "set", "openai", "sk-forbidden"],
      { manager: secrets, readSecret, stdout, stderr },
    )

    expect(code).toBe(1)
    expect(readSecret).not.toHaveBeenCalled()
    expect(secrets.set).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledWith("Usage: domovoid secret set <provider>\n")
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("sk-forbidden")
  })

  it("prints status and delete results as metadata only", async () => {
    const secrets = manager([
      { provider: "openai", state: "stored", source: "keychain" },
      { provider: "anthropic", state: "unavailable", source: "keychain" },
    ])
    const stdout = vi.fn()
    const stderr = vi.fn()
    const readSecret = vi.fn()

    expect(await runProviderSecretCommand(
      ["secret", "status"],
      { manager: secrets, readSecret, stdout, stderr },
    )).toBe(0)
    expect(await runProviderSecretCommand(
      ["secret", "delete", "openai"],
      { manager: secrets, readSecret, stdout, stderr },
    )).toBe(0)
    expect(stdout.mock.calls.flat().join(""))
      .toBe("openai: stored\nanthropic: unavailable\nopenai: not-set\n")
  })

  it("maps blank input and keychain failures to fixed safe errors", async () => {
    const secrets = manager()
    secrets.set.mockImplementation((_provider, secret) => {
      throw new Error(`native failure: ${secret}`)
    })
    const stdout = vi.fn()
    const stderr = vi.fn()

    expect(await runProviderSecretCommand(
      ["secret", "set", "openai"],
      { manager: secrets, readSecret: async () => " ", stdout, stderr },
    )).toBe(1)
    expect(await runProviderSecretCommand(
      ["secret", "set", "openai"],
      { manager: secrets, readSecret: async () => "sk-never-print", stdout, stderr },
    )).toBe(1)
    expect(stderr.mock.calls.flat()).toEqual([
      "Provider key cannot be empty\n",
      "OS keychain operation failed\n",
    ])
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("sk-never-print")
  })
})
