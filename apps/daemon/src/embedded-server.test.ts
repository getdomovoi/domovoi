import { afterEach, describe, expect, it, vi } from "vitest"

import { createAuthenticatedEmbeddedRuntime } from "./embedded-server.js"

const passwordEnvironment = "DOMOVOI_TEST_SERVER_PASSWORD"
const usernameEnvironment = "DOMOVOI_TEST_SERVER_USERNAME"
const originalPassword = process.env[passwordEnvironment]
const originalUsername = process.env[usernameEnvironment]

afterEach(() => {
  if (originalPassword === undefined) delete process.env[passwordEnvironment]
  else process.env[passwordEnvironment] = originalPassword
  if (originalUsername === undefined) delete process.env[usernameEnvironment]
  else process.env[usernameEnvironment] = originalUsername
})

describe("createAuthenticatedEmbeddedRuntime", () => {
  it("limits a generated server password to the child spawn and authenticates its client", async () => {
    process.env[passwordEnvironment] = "parent-value"
    process.env[usernameEnvironment] = "parent-user"
    const server = { url: "http://127.0.0.1:4096", close: vi.fn() }
    let spawnedPassword: string | undefined
    let spawnedUsername: string | undefined
    const startServer = vi.fn(() => {
      spawnedPassword = process.env[passwordEnvironment]
      spawnedUsername = process.env[usernameEnvironment]
      return Promise.resolve(server)
    })
    const client = { provider: "test" }
    const createClient = vi.fn(() => client)

    const runtime = await createAuthenticatedEmbeddedRuntime({
      passwordEnvironment,
      usernameEnvironment,
      username: "agent",
      config: { autoupdate: false },
      createPassword: () => "generated-password",
      startServer,
      createClient,
    })

    expect(spawnedPassword).toBe("generated-password")
    expect(spawnedUsername).toBe("agent")
    expect(process.env[passwordEnvironment]).toBe("parent-value")
    expect(process.env[usernameEnvironment]).toBe("parent-user")
    expect(startServer).toHaveBeenCalledWith({
      hostname: "127.0.0.1",
      port: 0,
      timeout: 10_000,
      config: { autoupdate: false },
    })
    expect(createClient).toHaveBeenCalledWith({
      baseUrl: server.url,
      headers: {
        authorization: `Basic ${Buffer.from("agent:generated-password").toString("base64")}`,
      },
    })
    expect(runtime).toEqual({ client, server })
  })

  it("closes the server when authenticated client creation fails", async () => {
    const server = { url: "http://127.0.0.1:4096", close: vi.fn() }

    await expect(createAuthenticatedEmbeddedRuntime({
      passwordEnvironment,
      usernameEnvironment,
      username: "agent",
      config: {},
      createPassword: () => "generated-password",
      startServer: async () => server,
      createClient: () => { throw new Error("client failed") },
    })).rejects.toThrow("client failed")

    expect(server.close).toHaveBeenCalledOnce()
  })
})
