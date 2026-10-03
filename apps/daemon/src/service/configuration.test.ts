import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DaemonConfigurationError, parseDaemonEnvironment } from "../config.js"
import { assertServiceProfile, callerProfile, createServiceConfiguration, parseServiceConfiguration, readServiceConfiguration, serializeServiceConfiguration, serviceEnvironment, ServiceProfileMismatchError } from "./configuration.js"

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

  // TailnetReach (Q404 A): the switch saves the tailnet listener with the
  // service, so the service answers on the tailnet as the in-app daemon does.
  it.each(["linux", "darwin", "win32"])("round trips the tailnet listener on %s", (platform) => {
    const root = platform === "win32" ? "C:\\Users\\Jean Doe" : "/home/Jean Doe"
    const tls = platform === "win32" ? `${root}\\.domovoi\\tls\\studio.tail4c2e.ts.net` : `${root}/.domovoi/tls/studio.tail4c2e.ts.net`
    const config = createServiceConfiguration({
      DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
      DOMOVOI_TAILNET_ADDRESS: "100.101.102.103",
      DOMOVOI_TAILNET_TLS_CERT_PATH: `${tls}.crt`,
      DOMOVOI_TAILNET_TLS_KEY_PATH: `${tls}.key`,
      DOMOVOI_TAILNET_HOST: "studio.tail4c2e.ts.net",
    }, { platform, homeDirectory: root, workingDirectory: root })
    const decoded = parseServiceConfiguration(serializeServiceConfiguration(config))
    expect(decoded).toEqual(config)
    expect(decoded).toMatchObject({ host: "127.0.0.1", tailnetHost: "studio.tail4c2e.ts.net",
      tailnetListener: { address: "100.101.102.103", tls: { certPath: `${tls}.crt`, keyPath: `${tls}.key` } } })
    expect(serviceEnvironment(decoded)).toMatchObject({
      DOMOVOI_HOST: "127.0.0.1",
      DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
      DOMOVOI_TAILNET_ADDRESS: "100.101.102.103",
      DOMOVOI_TAILNET_TLS_CERT_PATH: `${tls}.crt`,
      DOMOVOI_TAILNET_TLS_KEY_PATH: `${tls}.key`,
    })
  })

  const defaults = createServiceConfiguration({}, {
    platform: "linux", homeDirectory: "/home/test", workingDirectory: "/home/test",
  })
  const tailnetListener = { address: "100.101.102.103", tls: { certPath: "/home/test/.domovoi/tls/a.crt", keyPath: "/home/test/.domovoi/tls/a.key" } }
  it.each([
    { tailnetListener },
    { allowRemoteTransport: true, tailnetListener: { ...tailnetListener, address: "192.168.1.20" } },
    { allowRemoteTransport: true, tailnetListener: { ...tailnetListener, tls: { certPath: "tls/a.crt", keyPath: "/home/test/.domovoi/tls/a.key" } } },
    { allowRemoteTransport: true, tailnetListener: { address: "100.101.102.103" } },
    { allowRemoteTransport: true, tailnetListener: { ...tailnetListener, port: 443 } },
  ])("refuses a saved tailnet listener the daemon would refuse: %j", (override) => {
    expect(() => parseServiceConfiguration(JSON.stringify({ ...defaults, ...override })))
      .toThrow(/^Invalid service configuration\. Reinstall with valid non-secret daemon settings\.$/)
  })
  // Decided 2026-09-17 (SHIP-PLAN S1.1): whether Domovoi turned lingering on
  // is saved with the service, so removal turns off only its own.
  it.each([true, false])("keeps the Linux lingering record %s", (lingerEnabledByDomovoi) => {
    const text = serializeServiceConfiguration({ ...defaults, lingerEnabledByDomovoi })
    expect(parseServiceConfiguration(text)).toEqual({ ...defaults, lingerEnabledByDomovoi })
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
    { lingerEnabledByDomovoi: "yes" },
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

// A service's profile is named and compared by the rules of the platform the
// service is for, not the host's: a Windows host checking a macOS service
// showed \Users\dl\.domovoi (CI at 1b0d4d23), and a posix host compared
// Windows profiles case-sensitively. Each case runs on every host; the one
// whose rules differ from the host's is the one that failed.
describe("assertServiceProfile by the service platform's path rules", () => {
  // Runs a check as if this process ran on the given host, so the case whose
  // rules differ from the host's runs on every machine.
  const onHost = (host: NodeJS.Platform, check: () => void) => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { ...real, value: host })
    try { check() } finally { Object.defineProperty(process, "platform", real) }
  }

  it("names a macOS service's default profile with posix separators on a Windows host", () => {
    onHost("win32", () => {
      expect(() => assertServiceProfile({ profileDirectory: "/Users/dl/profiles/other" }, "/Users/dl", "darwin"))
        .toThrow("This app's daemon uses the profile at /Users/dl/.domovoi, and the login service uses the profile at /Users/dl/profiles/other.")
      expect(() => assertServiceProfile({ profileDirectory: "/Users/dl/.domovoi" }, "/Users/dl", "darwin")).not.toThrow()
      // As the service calls build it, from the app's environment.
      expect(() => assertServiceProfile({ profileDirectory: "/Users/dl/profiles/other" }, callerProfile({}, "/Users/dl", "darwin"), "darwin"))
        .toThrow("This app's daemon uses the profile at /Users/dl/.domovoi, and the login service uses the profile at /Users/dl/profiles/other.")
      expect(() => assertServiceProfile({ profileDirectory: "/Users/dl/profiles/work" }, callerProfile({ DOMOVOI_PROFILE_DIR: "/Users/dl/profiles/work" }, "/Users/dl", "darwin"), "darwin")).not.toThrow()
    })
  })

  it("compares Windows profiles as Windows does on a posix host", () => {
    onHost("linux", () => {
      expect(() => assertServiceProfile({ profileDirectory: "C:\\Users\\dl\\Profiles\\Work" }, { profileDirectory: "c:\\users\\dl\\profiles\\work" }, "win32")).not.toThrow()
    })
  })

  // Security review round 13 of #577 (P2): on a Linux service's machine,
  // link/../victim names victim beside the link's target. A Windows host
  // cannot follow that link, so such a path matches only the same path.
  it("does not collapse a posix dot-dot the host cannot resolve on the service's machine", () => {
    onHost("win32", () => {
      expect(() => assertServiceProfile({ profileDirectory: "/home/dl/link/../victim" }, { profileDirectory: "/home/dl/victim" }, "linux"))
        .toThrow(ServiceProfileMismatchError)
      expect(() => assertServiceProfile({ profileDirectory: "/home/dl/link/../victim" }, { profileDirectory: "/home/dl/link/../victim" }, "linux")).not.toThrow()
    })
  })

  it("names a macOS service's default profile with posix separators", () => {
    expect(() => assertServiceProfile({ profileDirectory: "/Users/dl/profiles/other" }, "/Users/dl", "darwin"))
      .toThrow("This app's daemon uses the profile at /Users/dl/.domovoi, and the login service uses the profile at /Users/dl/profiles/other.")
    expect(() => assertServiceProfile({ profileDirectory: "/Users/dl/.domovoi" }, "/Users/dl", "darwin")).not.toThrow()
  })

  it("names a Windows service's default profile with Windows separators", () => {
    expect(() => assertServiceProfile({ profileDirectory: "C:\\Users\\dl\\profiles\\other" }, "C:\\Users\\dl", "win32"))
      .toThrow("This app's daemon uses the profile at C:\\Users\\dl\\.domovoi, and the login service uses the profile at C:\\Users\\dl\\profiles\\other.")
  })

  it("compares Windows profiles as Windows does, ignoring case and separator form", () => {
    // Security review round 14 of #577 (P2): on a Windows host two missing
    // paths match only by exact text, so the case-free match is checked as
    // a remote comparison (owner ruling: exact case applies to local checks).
    onHost("linux", () => {
      expect(() => assertServiceProfile({ profileDirectory: "C:\\Users\\dl\\Profiles\\Work" }, { profileDirectory: "c:\\users\\dl\\profiles\\work" }, "win32")).not.toThrow()
      expect(() => assertServiceProfile({ profileDirectory: "C:\\Users\\dl\\.domovoi" }, "C:\\Users\\DL", "win32")).not.toThrow()
    })
    expect(() => assertServiceProfile({ profileDirectory: "C:\\Users\\dl\\profiles\\other" }, { profileDirectory: "C:\\Users\\dl\\profiles\\work" }, "win32"))
      .toThrow(ServiceProfileMismatchError)
  })
})
