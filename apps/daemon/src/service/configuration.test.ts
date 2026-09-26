import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DaemonConfigurationError, parseDaemonEnvironment } from "../config.js"
import { createServiceConfiguration, parseServiceConfiguration, readServiceConfiguration, serializeServiceConfiguration, serviceEnvironment } from "./configuration.js"

describe("service configuration", () => {
  it.each(["linux", "darwin", "win32"])("round trips every daemon setting on %s", (platform) => {
    const root = platform === "win32" ? "C:\\Users\\Jean Doe" : "/home/Jean Doe"
    const config = createServiceConfiguration({
      DOMOVOI_HOST: "::",
      DOMOVOI_PORT: "7717",
      DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
      DOMOVOI_TLS_CERT_PATH: "tls/cert.pem",
      DOMOVOI_TLS_KEY_PATH: "tls/private.key",
      DOMOVOI_CREDENTIAL_PATH: "state/daemon.token",
      DOMOVOI_MACHINE_IDENTITY_PATH: "state/machine.json",
      DOMOVOI_ADVERTISE_HOST: "studio.example.com",
      DOMOVOI_TAILNET_HOST: "studio.tailnet.example",
      DOMOVOI_SSH_TUNNELS: JSON.stringify([{ machineId: `machine-${"b".repeat(32)}`, endpoint: "ws://127.0.0.1:47900/rpc" }]),
      DOMOVOI_ALLOWED_ORIGINS: "https://app.example.com,file://",
      DOMOVOI_WEB_APP_URL: "https://app.example.com/connect",
      ANTHROPIC_API_KEY: "not-a-daemon-setting",
      NODE_OPTIONS: "not-a-daemon-setting",
    }, { platform, homeDirectory: root, workingDirectory: root })
    const text = serializeServiceConfiguration(config)
    const decoded = parseServiceConfiguration(text)
    const { version: _version, homeDirectory, ...settings } = config
    expect(decoded).toEqual(config)
    expect(decoded.webAppUrl).toBe("https://app.example.com/connect")
    expect(serviceEnvironment(decoded).DOMOVOI_WEB_APP_URL).toBe("https://app.example.com/connect")
    expect(decoded).toMatchObject({ tailnetHost: "studio.tailnet.example",
      sshTunnels: [{ machineId: `machine-${"b".repeat(32)}`, endpoint: "ws://127.0.0.1:47900/rpc" }] })
    // Same parser the production factory uses, not a test-only environment mapper.
    expect(parseDaemonEnvironment(serviceEnvironment(decoded), homeDirectory)).toEqual(settings)
    expect(config.tls?.keyPath).toBe(platform === "win32"
      ? `${root}\\tls\\private.key` : `${root}/tls/private.key`)
    expect(text).not.toContain("not-a-daemon-setting")
    expect(text).not.toContain("authToken")
  })

  const defaults = createServiceConfiguration({}, {
    platform: "linux", homeDirectory: "/home/test", workingDirectory: "/home/test",
  })
  it.each([
    { authToken: "s".repeat(43) },
    { environment: { DOMOVOI_AUTH_TOKEN: "s".repeat(43) } },
    { version: 2 },
    { port: -1 },
    { host: "0.0.0.0", allowRemoteTransport: true },
    { tls: { certPath: "/cert.pem" } },
    { credentialPath: "relative/daemon.token" },
    { allowedOrigins: ["https://app.example.com/path"] },
    { webAppUrl: "https://person:secret@app.example.com/" },
    { advertiseHost: "" },
    { extra: "unexpected" },
  ])("refuses invalid or secret-bearing saved state without echoing it: %j", (override) => {
    expect(() => parseServiceConfiguration(JSON.stringify({ ...defaults, ...override })))
      .toThrow(/^Invalid service configuration\. Reinstall with valid non-secret daemon settings\.$/)
  })

  // A saved address the daemon settings refuse is a configuration error, typed
  // as one, and the message does not repeat the address.
  it.each([
    "https://person:secret@app.example.com/", "https://app.example.com/#code",
    ...[
      " https://app.domovoi.dev/", "https://app.domovoi.dev/ ", "https://app.domovoi.dev/con nect",
      "https://app.domovoi.dev/\tconnect", "https://app.domovoi.dev/connect\r\n", "https://app.domovoi.dev/\nconnect",
      "https://app.domovoi.dev/\u0000", "https://app.domovoi.dev/\u007f", "https://app.domovoi.dev/\u0085",
      "https://app.domovoi.dev/\u00a0", "https://app.domovoi.dev/\u2028",
    ],
  ])("refuses a saved web app address as a configuration error without echoing it: %j", (webAppUrl) => {
    let thrown: unknown
    try {
      parseServiceConfiguration(JSON.stringify({ ...defaults, webAppUrl }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DaemonConfigurationError)
    expect((thrown as Error).message).toBe("Invalid service configuration. Reinstall with valid non-secret daemon settings.")
  })

  const sanitized = "Invalid service configuration. Reinstall with valid non-secret daemon settings."
  const thrownBy = (run: () => unknown): unknown => {
    try {
      run()
    } catch (error) {
      return error
    }
    return undefined
  }
  const refusedWebAppUrls: Array<[string, unknown]> = [
    ["null", null],
    ["a number", 7717],
    ["an object", { href: "https://person:secret@app.example.com/" }],
    ["an array", ["https://person:secret@app.example.com/"]],
    ["a refused string", "https://person:secret@app.example.com/"],
  ]

  it.each(refusedWebAppUrls)("refuses a saved web app address that is %s as a configuration error", (_label, webAppUrl) => {
    const thrown = thrownBy(() => parseServiceConfiguration(JSON.stringify({ ...defaults, webAppUrl })))
    expect(thrown).toBeInstanceOf(DaemonConfigurationError)
    expect((thrown as Error).message).toBe(sanitized)
    expect((thrown as Error).cause).toBeUndefined()
  })

  it.each([
    ["malformed JSON", "{"],
    ["an unknown field", JSON.stringify({ ...defaults, extra: "unexpected" })],
  ])("keeps %s a plain error", (_label, text) => {
    const thrown = thrownBy(() => parseServiceConfiguration(text))
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(DaemonConfigurationError)
    expect((thrown as Error).message).toBe(sanitized)
  })

  describe("loading the saved file", () => {
    let directory = ""
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "domovoi-service-configuration-"))
    })
    afterEach(async () => {
      await rm(directory, { recursive: true, force: true })
    })
    const loaded = async (text: string): Promise<{ thrown: unknown, path: string }> => {
      const path = join(directory, "service.json")
      await writeFile(path, text)
      try {
        await readServiceConfiguration(path)
      } catch (error) {
        return { thrown: error, path }
      }
      return { thrown: undefined, path }
    }

    it.each(refusedWebAppUrls)("keeps a saved web app address that is %s a configuration error", async (_label, webAppUrl) => {
      const { thrown, path } = await loaded(JSON.stringify({ ...defaults, webAppUrl }))
      expect(thrown).toBeInstanceOf(DaemonConfigurationError)
      expect((thrown as Error).message).toBe(`Could not load service configuration at ${path}. Reinstall the service before restarting.`)
      const cause = (thrown as Error).cause
      expect(cause).toBeInstanceOf(DaemonConfigurationError)
      expect((cause as Error).message).toBe(sanitized)
      expect((cause as Error).cause).toBeUndefined()
      expect(`${(thrown as Error).message.replace(path, "")} ${(cause as Error).message}`).not.toMatch(/person:secret|7717|app\.example\.com/)
    })

    it.each([
      ["malformed JSON", "{"],
      ["an unknown field", JSON.stringify({ ...defaults, extra: "unexpected" })],
    ])("keeps %s a plain error", async (_label, text) => {
      const { thrown, path } = await loaded(text)
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown).not.toBeInstanceOf(DaemonConfigurationError)
      expect((thrown as Error).message).toBe(`Could not load service configuration at ${path}. Reinstall the service before restarting.`)
      expect((thrown as Error).cause).not.toBeInstanceOf(DaemonConfigurationError)
    })
  })

  it("bounds the saved configuration and refuses broken JSON", () => {
    expect(() => parseServiceConfiguration("{" )).toThrow(/Invalid service configuration/)
    expect(() => parseServiceConfiguration(`${JSON.stringify(defaults)}${" ".repeat(64 * 1_024)}`)).toThrow(/Invalid service configuration/)
  })
})
