import { afterEach, describe, expect, it, vi } from "vitest"

const spawnedEnvironments = vi.hoisted(() => [] as Array<Record<string, string | undefined>>)
// The executable versions the default factories read, by command. No test
// here runs `opencode` or `kilo`.
const versions = vi.hoisted(() => ({ read: vi.fn(async (command: string): Promise<string> => (command === "kilo" ? "7.8.1" : "1.18.33")) }))

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
vi.mock("./embedded-version.js", async (original) => {
  const actual = await original<typeof import("./embedded-version.js")>()
  return {
    ...actual,
    readExecutableVersion: versions.read,
    requireTestedVersion: (expected: Parameters<typeof actual.requireTestedVersion>[0]) => actual.requireTestedVersion(expected, versions.read),
  }
})

const { KiloSdkAdapter } = await import("./kilo.js")
const { OpenCodeSdkAdapter } = await import("./opencode.js")

afterEach(() => {
  spawnedEnvironments.splice(0)
  versions.read.mockClear()
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

  // Security review round 4 of #687 (P2): the permission and tool lists are
  // tied to the server versions they were read from, and the SDKs start the
  // executable found on PATH. The default factories read its version first
  // and start nothing but a release that passed the live contract (round 5).
  it.each([
    ["OpenCode", "opencode", "1.19.0", "OpenCode 1.18.32 and 1.18.33", () => new OpenCodeSdkAdapter()],
    ["OpenCode", "opencode", "1.18.34", "OpenCode 1.18.32 and 1.18.33", () => new OpenCodeSdkAdapter()],
    ["Kilo", "kilo", "7.8.2", "Kilo 7.8.1", () => new KiloSdkAdapter()],
  ] as const)("refuses to start %s (%s %s) at an untested release", async (_name, command, found, tested, create) => {
    versions.read.mockImplementation(async (asked: string) => (asked === command ? found : "0.0.0"))
    const adapter = create()
    await expect(adapter.connect()).rejects.toThrow(`${found} is not a release`)
    await expect(create().connect()).rejects.toThrow(tested)
    expect(spawnedEnvironments).toHaveLength(0)
    expect(versions.read).toHaveBeenCalledWith(command)
    await adapter.close()
  })
})
