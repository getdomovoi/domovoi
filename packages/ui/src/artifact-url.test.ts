import { describe, expect, it } from "vitest"

import { artifactUrlFor } from "./artifact-url"

describe("artifactUrlFor", () => {
  it("maps the RPC WebSocket endpoint to an encoded HTTP artifact URL", () => {
    expect(artifactUrlFor("ws://127.0.0.1:47831/rpc", "preview/a b")).toBe(
      "http://127.0.0.1:47831/artifacts/preview%2Fa%20b",
    )
    expect(artifactUrlFor("wss://domovoi.example/rpc", "preview-1")).toBe(
      "https://domovoi.example/artifacts/preview-1",
    )
  })

  it("adds an isolated preview bridge channel", () => {
    expect(artifactUrlFor(
      "ws://127.0.0.1:47831/rpc",
      "preview-1",
      "preview_channel_123456",
      "https://app.domovoi.sh",
    )).toBe(
      "http://127.0.0.1:47831/artifacts/preview-1?bridge=preview_channel_123456&parentOrigin=https%3A%2F%2Fapp.domovoi.sh",
    )
  })
})
