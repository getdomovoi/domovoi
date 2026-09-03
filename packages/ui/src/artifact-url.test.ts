import { describe, expect, it } from "vitest"

import { artifactUrlFor } from "./artifact-url"

describe("artifactUrlFor", () => {
  it("maps the RPC WebSocket endpoint to an encoded HTTP artifact URL", () => {
    expect(artifactUrlFor("ws://127.0.0.1:47831/rpc", {
      sessionId: "session-a",
      artifactId: "preview/a b",
      revision: 4,
      purpose: "print",
      expiresAt: 1_800_000_000,
      signature: "a".repeat(43),
    })).toBe(
      `http://127.0.0.1:47831/artifacts/preview%2Fa%20b?session=session-a&revision=4&purpose=print&expires=1800000000&signature=${"a".repeat(43)}`,
    )
    expect(artifactUrlFor("wss://domovoi.example/rpc", {
      sessionId: "session-a",
      artifactId: "preview-1",
      revision: 2,
      purpose: "download",
      expiresAt: 1_800_000_000,
      signature: "b".repeat(43),
    })).toBe(
      `https://domovoi.example/artifacts/preview-1?session=session-a&revision=2&purpose=download&expires=1800000000&signature=${"b".repeat(43)}`,
    )
  })

  it("adds an isolated preview bridge channel and its signed parent origin", () => {
    expect(artifactUrlFor("ws://127.0.0.1:47831/rpc", {
      sessionId: "session-a",
      artifactId: "preview-1",
      revision: 3,
      purpose: "preview",
      bridgeChannel: "preview_channel_123456",
      parentOrigin: "https://app.domovoi.sh",
      expiresAt: 1_800_000_000,
      signature: "c".repeat(43),
    })).toBe(
      `http://127.0.0.1:47831/artifacts/preview-1?session=session-a&revision=3&purpose=preview&bridge=preview_channel_123456&parentOrigin=https%3A%2F%2Fapp.domovoi.sh&expires=1800000000&signature=${"c".repeat(43)}`,
    )
    expect(artifactUrlFor("ws://127.0.0.1:47831/rpc", {
      sessionId: "session-a",
      artifactId: "preview-1",
      revision: 3,
      purpose: "preview",
      bridgeChannel: "preview_channel_123456",
      parentOrigin: "null",
      expiresAt: 1_800_000_000,
      signature: "c".repeat(43),
    })).toContain("&parentOrigin=null&")
    expect(artifactUrlFor("ws://127.0.0.1:47831/rpc", {
      sessionId: "session-a",
      artifactId: "preview-1",
      revision: 3,
      purpose: "preview",
      bridgeChannel: "preview_channel_123456",
      expiresAt: 1_800_000_000,
      signature: "c".repeat(43),
    })).not.toContain("parentOrigin")
  })
})

describe("artifactUrlFor across schemes", () => {
  const access = {
    artifactId: "artifact-1",
    sessionId: "session-1",
    revision: 2,
    purpose: "preview",
    expiresAt: 1_700_000_000_000,
    signature: "signature",
  } as const

  it("keeps an https rpc url on https", () => {
    expect(artifactUrlFor("https://daemon.test:47831/rpc", access)).toMatch(/^https:\/\//)
  })

  it("keeps a wss rpc url on https", () => {
    expect(artifactUrlFor("wss://daemon.test:47831/rpc", access)).toMatch(/^https:\/\//)
  })

  it("leaves a plaintext rpc url on http", () => {
    expect(artifactUrlFor("ws://127.0.0.1:47831/rpc", access)).toMatch(/^http:\/\//)
    expect(artifactUrlFor("http://127.0.0.1:47831/rpc", access)).toMatch(/^http:\/\//)
  })

  it("never downgrades a secure rpc url to plaintext", () => {
    for (const rpcUrl of ["https://daemon.test/rpc", "wss://daemon.test/rpc"]) {
      expect(artifactUrlFor(rpcUrl, access)).not.toContain("http://")
    }
  })
})
