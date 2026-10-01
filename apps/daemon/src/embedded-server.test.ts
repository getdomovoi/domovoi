import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createAuthenticatedEmbeddedRuntime, embeddedServerCommand } from "./embedded-server.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { waitForDaemon } from "./test-wait-for.js"

const passwordEnvironment = "DOMOVOI_TEST_SERVER_PASSWORD"
const usernameEnvironment = "DOMOVOI_TEST_SERVER_USERNAME"
const originalPassword = process.env[passwordEnvironment]
const originalUsername = process.env[usernameEnvironment]
const scratchDirectories: string[] = []

afterEach(async () => {
  if (originalPassword === undefined) delete process.env[passwordEnvironment]
  else process.env[passwordEnvironment] = originalPassword
  if (originalUsername === undefined) delete process.env[usernameEnvironment]
  else process.env[usernameEnvironment] = originalUsername
  await removeScratchDirectories(scratchDirectories.splice(0))
})

const fakeServer = () => ({ url: "http://127.0.0.1:4096", close: vi.fn(), stop: vi.fn(async () => true) })

describe("createAuthenticatedEmbeddedRuntime", () => {
  it("gives a generated server password to the server's environment only and authenticates its client", async () => {
    process.env[passwordEnvironment] = "parent-value"
    process.env[usernameEnvironment] = "parent-user"
    const server = fakeServer()
    const startServer = vi.fn(async () => server)
    const client = { provider: "test" }
    const createClient = vi.fn(() => client)

    const runtime = await createAuthenticatedEmbeddedRuntime({
      passwordEnvironment,
      usernameEnvironment,
      username: "agent",
      environment: { DOMOVOI_TEST_CONFIG_CONTENT: "{\"autoupdate\":false}" },
      createPassword: () => "generated-password",
      startServer,
      createClient,
    })

    expect(startServer).toHaveBeenCalledWith({
      hostname: "127.0.0.1",
      port: 0,
      timeout: 10_000,
      environment: {
        DOMOVOI_TEST_CONFIG_CONTENT: "{\"autoupdate\":false}",
        [passwordEnvironment]: "generated-password",
        [usernameEnvironment]: "agent",
      },
    })
    // The daemon's own environment never holds it, not even for a moment.
    expect(process.env[passwordEnvironment]).toBe("parent-value")
    expect(process.env[usernameEnvironment]).toBe("parent-user")
    expect(createClient).toHaveBeenCalledWith({
      baseUrl: server.url,
      headers: {
        authorization: `Basic ${Buffer.from("agent:generated-password").toString("base64")}`,
      },
    })
    expect(runtime).toEqual({ client, server })
  })

  it("closes the server when authenticated client creation fails", async () => {
    const server = fakeServer()

    await expect(createAuthenticatedEmbeddedRuntime({
      passwordEnvironment,
      usernameEnvironment,
      username: "agent",
      createPassword: () => "generated-password",
      startServer: async () => server,
      createClient: () => { throw new Error("client failed") },
    })).rejects.toThrow("client failed")

    expect(server.close).toHaveBeenCalledOnce()
  })
})

// Codex review of #691, P1: a stop that cannot be confirmed must not be
// reported as one. The server leads its own process group, so a stop ends
// it and every process it started, and says whether that happened.
describe.skipIf(process.platform === "win32")("embeddedServerCommand", () => {
  async function fixture(body: string) {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-embedded-server-"))
    scratchDirectories.push(directory)
    const command = join(directory, "fixture-server")
    await writeFile(command, `#!${process.execPath}\n${body}\n`)
    await chmod(command, 0o755)
    return { command, report: join(directory, "report.json") }
  }

  const listening = `
const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
writeFileSync(process.env.FIXTURE_REPORT, JSON.stringify({
  server: process.pid,
  helper: helper.pid,
  argv: process.argv.slice(2),
  password: process.env.FIXTURE_PASSWORD ?? null,
}))
console.log("fixture server listening on http://127.0.0.1:4567")
setInterval(() => {}, 1000)`

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it("starts the server with its own environment and reports where it listens", async () => {
    const { command, report } = await fixture(listening)
    const start = embeddedServerCommand(command, "fixture server listening")

    const server = await start({
      hostname: "127.0.0.1",
      port: 0,
      timeout: 10_000,
      environment: { FIXTURE_REPORT: report, FIXTURE_PASSWORD: "only-the-server" },
    })

    expect(server.url).toBe("http://127.0.0.1:4567")
    const facts = JSON.parse(await readFile(report, "utf8")) as { argv: string[], password: string | null }
    expect(facts.argv).toEqual(["serve", "--hostname=127.0.0.1", "--port=0"])
    expect(facts.password).toBe("only-the-server")
    expect(process.env.FIXTURE_PASSWORD).toBeUndefined()
    await expect(server.stop()).resolves.toBe(true)
  })

  it("stops the server and every process it started, and says so", async () => {
    const { command, report } = await fixture(listening)
    const server = await embeddedServerCommand(command, "fixture server listening")({
      hostname: "127.0.0.1", port: 0, timeout: 10_000, environment: { FIXTURE_REPORT: report },
    })
    const facts = JSON.parse(await readFile(report, "utf8")) as { server: number, helper: number }
    expect(alive(facts.server)).toBe(true)
    expect(alive(facts.helper)).toBe(true)

    await expect(server.stop()).resolves.toBe(true)

    await waitForDaemon(() => {
      expect(alive(facts.server)).toBe(false)
      expect(alive(facts.helper)).toBe(false)
    })
  })

  it("refuses a server that exits before it listens, with what it said", async () => {
    const { command } = await fixture(`console.error("no provider configured"); process.exit(3)`)

    await expect(embeddedServerCommand(command, "fixture server listening")({
      hostname: "127.0.0.1", port: 0, timeout: 10_000, environment: {},
    })).rejects.toThrow(/exited with code 3[\s\S]*no provider configured/u)
  })

  it("stops a server that does not listen in time", async () => {
    const { command, report } = await fixture(`
const { writeFileSync } = require("node:fs")
writeFileSync(process.env.FIXTURE_REPORT, JSON.stringify({ server: process.pid }))
setInterval(() => {}, 1000)`)

    await expect(embeddedServerCommand(command, "fixture server listening")({
      hostname: "127.0.0.1", port: 0, timeout: 500, environment: { FIXTURE_REPORT: report },
    })).rejects.toThrow(/did not start listening within 500 ms/u)
    const facts = JSON.parse(await readFile(report, "utf8")) as { server: number }
    await waitForDaemon(() => expect(alive(facts.server)).toBe(false))
  })
})
