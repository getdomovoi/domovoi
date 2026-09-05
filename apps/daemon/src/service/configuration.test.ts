import { describe, expect, it } from "vitest"

import { parseDaemonEnvironment } from "../config.js"
import { createServiceConfiguration, parseServiceConfiguration, serializeServiceConfiguration, serviceEnvironment } from "./configuration.js"

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
      ANTHROPIC_API_KEY: "not-a-daemon-setting",
      NODE_OPTIONS: "not-a-daemon-setting",
    }, { platform, homeDirectory: root, workingDirectory: root })
    const text = serializeServiceConfiguration(config)
    const decoded = parseServiceConfiguration(text)
    const { version: _version, homeDirectory, ...settings } = config
    expect(decoded).toEqual(config)
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
    { advertiseHost: "" },
    { extra: "unexpected" },
  ])("refuses invalid or secret-bearing saved state without echoing it: %j", (override) => {
    expect(() => parseServiceConfiguration(JSON.stringify({ ...defaults, ...override })))
      .toThrow(/^Invalid service configuration\. Reinstall with valid non-secret daemon settings\.$/)
  })

  it("bounds the saved configuration and refuses broken JSON", () => {
    expect(() => parseServiceConfiguration("{" )).toThrow(/Invalid service configuration/)
    expect(() => parseServiceConfiguration(`${JSON.stringify(defaults)}${" ".repeat(64 * 1_024)}`)).toThrow(/Invalid service configuration/)
  })
})
