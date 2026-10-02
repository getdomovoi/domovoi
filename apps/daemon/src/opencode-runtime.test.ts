import { afterEach, describe, expect, it, vi } from "vitest"

const spawned = vi.hoisted(() => [] as Array<{ command: string, environment: Readonly<Record<string, string>> }>)
// The executable versions the default factories read, by command. No test
// here runs `opencode` or `kilo`.
const versions = vi.hoisted(() => ({ read: vi.fn(async (command: string): Promise<string> => (command === "kilo" ? "7.8.1" : "1.18.33")) }))

function fakeClient() {
  return vi.fn(() => ({
    config: { get: vi.fn(), providers: vi.fn() },
    session: {
      create: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      abort: vi.fn(),
      promptAsync: vi.fn(),
      messages: vi.fn(),
      status: vi.fn(),
    },
    event: { subscribe: vi.fn() },
    postSessionIdPermissionsPermissionId: vi.fn(),
  }))
}

vi.mock("./embedded-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedded-server.js")>()
  return {
    ...actual,
    embeddedServerCommand: (command: string) => async (options: { environment: Readonly<Record<string, string>> }) => {
      spawned.push({ command, environment: options.environment })
      return { url: "http://127.0.0.1:4096", close: vi.fn(), stop: vi.fn(async () => true) }
    },
  }
})
vi.mock("@opencode-ai/sdk", () => ({ createOpencodeClient: fakeClient() }))
vi.mock("@kilocode/sdk", () => ({ createKiloClient: fakeClient() }))
vi.mock("./embedded-version.js", async (original) => {
  const actual = await original<typeof import("./embedded-version.js")>()
  return {
    ...actual,
    readExecutableVersion: versions.read,
    requireTestedVersion: (expected: Parameters<typeof actual.requireTestedVersion>[0]) => actual.requireTestedVersion(expected, versions.read),
  }
})

const { KiloSdkAdapter } = await import("./kilo.js")
const { domovoiKiloConfig } = await import("./kilo-runtime.js")
const { OpenCodeSdkAdapter, domovoiOpenCodeConfig } = await import("./opencode.js")

afterEach(() => {
  spawned.splice(0)
  versions.read.mockClear()
})

describe("embedded provider servers", () => {
  it.each([
    ["OpenCode", () => new OpenCodeSdkAdapter(), "opencode", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_CONFIG_CONTENT", domovoiOpenCodeConfig],
    ["Kilo", () => new KiloSdkAdapter(), "kilo", "KILO_DISABLE_PROJECT_CONFIG", "KILO_CONFIG_CONTENT", domovoiKiloConfig],
  ] as const)("start %s with Domovoi's rules and repository configuration switched off, for the server only", async (
    _name, create, command, flag, content, config,
  ) => {
    const before = process.env[flag]
    const adapter = create()

    await adapter.connect()

    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.command).toBe(command)
    expect(spawned[0]?.environment[flag]).toBe("1")
    expect(JSON.parse(spawned[0]?.environment[content] ?? "null")).toEqual(config)
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
    expect(spawned).toHaveLength(0)
    expect(versions.read).toHaveBeenCalledWith(command)
    await adapter.close()
  })
})
