import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { DaemonConfigurationError, parseDaemonEnvironment } from "./config.js"

describe("parseDaemonEnvironment", () => {
  it("returns bounded local defaults", () => {
    expect(parseDaemonEnvironment({}, "/home/tester")).toEqual({
      host: "127.0.0.1",
      port: 47831,
      credentialPath: join("/home/tester", ".domovoi", "daemon.token"),
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
    expect(() => parseDaemonEnvironment({ DOMOVOI_AUTH_TOKEN: "" }, "/home/tester"))
      .toThrow("DOMOVOI_AUTH_TOKEN")
    expect(() => parseDaemonEnvironment({ DOMOVOI_CREDENTIAL_PATH: "  " }, "/home/tester"))
      .toThrow("DOMOVOI_CREDENTIAL_PATH")
    expect(parseDaemonEnvironment({
      DOMOVOI_AUTH_TOKEN: "secret-token",
      DOMOVOI_CREDENTIAL_PATH: "/run/secrets/domovoi-token",
    }, "/home/tester")).toMatchObject({
      authToken: "secret-token",
      credentialPath: "/run/secrets/domovoi-token",
    })
  })

  it.each(["token with spaces", "token.with.dots", "token/slash", "påssword"])(
    "rejects auth tokens outside the bearer parser charset: %s",
    (authToken) => {
      expect(() => parseDaemonEnvironment({ DOMOVOI_AUTH_TOKEN: authToken }, "/home/tester"))
        .toThrow("A-Z, a-z, 0-9, hyphen, and underscore")
    },
  )
})
