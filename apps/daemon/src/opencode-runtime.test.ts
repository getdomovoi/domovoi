import { afterEach, describe, expect, it, vi } from "vitest"

const spawned = vi.hoisted(() => [] as Array<{ command: string, environment: Readonly<Record<string, string>> }>)

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

const { KiloSdkAdapter } = await import("./kilo.js")
const { domovoiKiloConfig } = await import("./kilo-runtime.js")
const { OpenCodeSdkAdapter, domovoiOpenCodeConfig } = await import("./opencode.js")

afterEach(() => {
  spawned.splice(0)
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
})
