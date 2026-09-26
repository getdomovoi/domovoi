import { afterEach, describe, expect, it, vi } from "vitest"

const spawnedEnvironments = vi.hoisted(() => [] as Array<Record<string, string | undefined>>)

function fakeServerModule() {
  return {
    startServer: vi.fn(async () => {
      spawnedEnvironments.push({ ...process.env })
      return { url: "http://127.0.0.1:4096", close: vi.fn() }
    }),
    createClient: vi.fn(() => ({
      config: { get: vi.fn(), providers: vi.fn() },
      session: {
        create: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        abort: vi.fn(),
        promptAsync: vi.fn(),
        messages: vi.fn(),
      },
      event: { subscribe: vi.fn() },
      postSessionIdPermissionsPermissionId: vi.fn(),
    })),
  }
}

vi.mock("@opencode-ai/sdk", () => {
  const fake = fakeServerModule()
  return { createOpencodeServer: fake.startServer, createOpencodeClient: fake.createClient }
})
vi.mock("@kilocode/sdk", () => {
  const fake = fakeServerModule()
  return { createKiloServer: fake.startServer, createKiloClient: fake.createClient }
})

const { KiloSdkAdapter } = await import("./kilo.js")
const { OpenCodeSdkAdapter } = await import("./opencode.js")

afterEach(() => {
  spawnedEnvironments.splice(0)
})

describe("embedded provider servers", () => {
  it.each([
    ["OpenCode", () => new OpenCodeSdkAdapter(), "OPENCODE_DISABLE_PROJECT_CONFIG"],
    ["Kilo", () => new KiloSdkAdapter(), "KILO_DISABLE_PROJECT_CONFIG"],
  ] as const)("start %s with repository configuration and plugins switched off", async (_name, create, flag) => {
    const before = process.env[flag]
    const adapter = create()

    await adapter.connect()

    expect(spawnedEnvironments).toHaveLength(1)
    expect(spawnedEnvironments[0]?.[flag]).toBe("1")
    expect(process.env[flag]).toBe(before)
    await adapter.close()
  })
})
