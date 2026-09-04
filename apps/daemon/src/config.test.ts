import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { DaemonConfigurationError, parseDaemonEnvironment } from "./config.js"

describe("parseDaemonEnvironment", () => {
  it("returns bounded local defaults", () => {
    expect(parseDaemonEnvironment({}, "/home/tester")).toEqual({
      host: "127.0.0.1",
      port: 47831,
      credentialPath: join("/home/tester", ".domovoi", "daemon.token"),
      machineIdentityPath: join("/home/tester", ".domovoi", "machine.json"),
      allowRemoteTransport: false,
    })
  })

  it.each(["", "0", "65536", "47831garbage", "1.5", "-1"])(
    "rejects invalid ports: %s",
    (port) => {
      expect(() => parseDaemonEnvironment({ DOMOVOI_PORT: port }, "/home/tester"))
        .toThrow(DaemonConfigurationError)
    },
  )

  it("requires explicit remote transport for non-loopback hosts", () => {
    expect(() => parseDaemonEnvironment({ DOMOVOI_HOST: "0.0.0.0" }, "/home/tester"))
      .toThrow("DOMOVOI_ALLOW_REMOTE_TRANSPORT=1")
    expect(parseDaemonEnvironment({
      DOMOVOI_HOST: "0.0.0.0",
      DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
      DOMOVOI_TLS_CERT_PATH: "/etc/domovoi/cert.pem",
      DOMOVOI_TLS_KEY_PATH: "/etc/domovoi/key.pem",
    }, "/home/tester")).toMatchObject({
      host: "0.0.0.0",
      allowRemoteTransport: true,
    })
  })

  it.each(["yes", "true", "2", " 1 "])("rejects invalid remote flags: %s", (flag) => {
    expect(() => parseDaemonEnvironment({
      DOMOVOI_ALLOW_REMOTE_TRANSPORT: flag,
    }, "/home/tester")).toThrow(DaemonConfigurationError)
  })

  it("normalizes and deduplicates trusted browser origins", () => {
    expect(parseDaemonEnvironment({
      DOMOVOI_ALLOWED_ORIGINS: "https://app.domovoi.sh/, file://,http://localhost:5178,https://app.domovoi.sh",
    }, "/home/tester").allowedOrigins).toEqual([
      "https://app.domovoi.sh",
      "file://",
      "http://localhost:5178",
    ])
  })

  it.each([
    "",
    "not-a-url",
    "file:///",
    "file://host",
    "wss://app.domovoi.sh",
    "https://user:pass@app.domovoi.sh",
    "https://app.domovoi.sh/path",
  ])("rejects invalid trusted origins: %s", (origins) => {
    expect(() => parseDaemonEnvironment({
      DOMOVOI_ALLOWED_ORIGINS: origins,
    }, "/home/tester")).toThrow(DaemonConfigurationError)
  })

  it("rejects empty credential settings and preserves explicit values", () => {
    const authToken = "s".repeat(43)
    expect(() => parseDaemonEnvironment({ DOMOVOI_AUTH_TOKEN: "" }, "/home/tester"))
      .toThrow("DOMOVOI_AUTH_TOKEN")
    expect(() => parseDaemonEnvironment({ DOMOVOI_CREDENTIAL_PATH: "  " }, "/home/tester"))
      .toThrow("DOMOVOI_CREDENTIAL_PATH")
    expect(parseDaemonEnvironment({
      DOMOVOI_AUTH_TOKEN: authToken,
      DOMOVOI_CREDENTIAL_PATH: "/run/secrets/domovoi-token",
    }, "/home/tester")).toMatchObject({
      authToken,
      credentialPath: "/run/secrets/domovoi-token",
    })
  })

  it.each(["x", "n".repeat(42), "n".repeat(44)])(
    "rejects configured daemon credentials without 256 bits: %s",
    (authToken) => {
      expect(() => parseDaemonEnvironment({ DOMOVOI_AUTH_TOKEN: authToken }, "/home/tester"))
        .toThrow("43-character base64url")
    },
  )

  it("reads TLS material for an encrypted listener", () => {
    expect(parseDaemonEnvironment({
      DOMOVOI_TLS_CERT_PATH: "/etc/domovoi/cert.pem",
      DOMOVOI_TLS_KEY_PATH: "/etc/domovoi/key.pem",
    }, "/home/tester").tls).toEqual({
      certPath: "/etc/domovoi/cert.pem",
      keyPath: "/etc/domovoi/key.pem",
    })
  })

  it("serves plaintext on loopback when no TLS material is given", () => {
    expect(parseDaemonEnvironment({}, "/home/tester").tls).toBeUndefined()
  })

  it("refuses half-configured TLS material", () => {
    expect(() => parseDaemonEnvironment({
      DOMOVOI_TLS_CERT_PATH: "/etc/domovoi/cert.pem",
    }, "/home/tester")).toThrow("DOMOVOI_TLS_CERT_PATH and DOMOVOI_TLS_KEY_PATH must be set together")
    expect(() => parseDaemonEnvironment({
      DOMOVOI_TLS_KEY_PATH: "/etc/domovoi/key.pem",
    }, "/home/tester")).toThrow("DOMOVOI_TLS_CERT_PATH and DOMOVOI_TLS_KEY_PATH must be set together")
  })

  it("refuses an empty TLS path", () => {
    expect(() => parseDaemonEnvironment({
      DOMOVOI_TLS_CERT_PATH: "  ",
      DOMOVOI_TLS_KEY_PATH: "/etc/domovoi/key.pem",
    }, "/home/tester")).toThrow("DOMOVOI_TLS_CERT_PATH cannot be empty")
  })

  it("refuses to serve a non-loopback listener without TLS", () => {
    expect(() => parseDaemonEnvironment({
      DOMOVOI_HOST: "0.0.0.0",
      DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
    }, "/home/tester")).toThrow("Non-loopback DOMOVOI_HOST requires TLS")
  })

  it("accepts a non-loopback listener that is opted in and encrypted", () => {
    expect(parseDaemonEnvironment({
      DOMOVOI_HOST: "0.0.0.0",
      DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
      DOMOVOI_TLS_CERT_PATH: "/etc/domovoi/cert.pem",
      DOMOVOI_TLS_KEY_PATH: "/etc/domovoi/key.pem",
    }, "/home/tester")).toMatchObject({
      host: "0.0.0.0",
      allowRemoteTransport: true,
      tls: { certPath: "/etc/domovoi/cert.pem", keyPath: "/etc/domovoi/key.pem" },
    })
  })

  it("reads the name an encrypted listener is reachable by", () => {
    expect(parseDaemonEnvironment({
      DOMOVOI_HOST: "0.0.0.0",
      DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
      DOMOVOI_TLS_CERT_PATH: "/etc/domovoi/cert.pem",
      DOMOVOI_TLS_KEY_PATH: "/etc/domovoi/key.pem",
      DOMOVOI_ADVERTISE_HOST: "workshop.tailnet",
    }, "/home/tester").advertiseHost).toBe("workshop.tailnet")
  })

  it("advertises nothing by name when none is configured", () => {
    expect(parseDaemonEnvironment({}, "/home/tester").advertiseHost).toBeUndefined()
  })

  it("refuses an empty advertised name", () => {
    expect(() => parseDaemonEnvironment({ DOMOVOI_ADVERTISE_HOST: "  " }, "/home/tester"))
      .toThrow("DOMOVOI_ADVERTISE_HOST cannot be empty")
  })

  it("overrides the machine identity path", () => {
    expect(() => parseDaemonEnvironment({ DOMOVOI_MACHINE_IDENTITY_PATH: "  " }, "/home/tester"))
      .toThrow("DOMOVOI_MACHINE_IDENTITY_PATH")
    expect(parseDaemonEnvironment({
      DOMOVOI_MACHINE_IDENTITY_PATH: "/var/lib/domovoi/machine.json",
    }, "/home/tester")).toMatchObject({
      machineIdentityPath: "/var/lib/domovoi/machine.json",
    })
  })

  it.each(["token with spaces", "token.with.dots", "token/slash", "påssword"])(
    "rejects malformed configured daemon credentials: %s",
    (authToken) => {
      expect(() => parseDaemonEnvironment({ DOMOVOI_AUTH_TOKEN: authToken }, "/home/tester"))
        .toThrow("43-character base64url")
    },
  )
})
