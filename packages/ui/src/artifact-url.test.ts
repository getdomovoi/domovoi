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

  it("adds an isolated preview bridge channel", () => {
    expect(artifactUrlFor(
      "ws://127.0.0.1:47831/rpc",
      {
        sessionId: "session-a",
        artifactId: "preview-1",
        revision: 3,
        purpose: "preview",
        bridgeChannel: "preview_channel_123456",
        expiresAt: 1_800_000_000,
        signature: "c".repeat(43),
      },
      "https://app.domovoi.sh",
    )).toBe(
      `http://127.0.0.1:47831/artifacts/preview-1?session=session-a&revision=3&purpose=preview&bridge=preview_channel_123456&parentOrigin=https%3A%2F%2Fapp.domovoi.sh&expires=1800000000&signature=${"c".repeat(43)}`,
    )
  })
})
