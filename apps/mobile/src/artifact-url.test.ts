import { describe, expect, it } from "vitest"

import { artifactUrlFor } from "./artifact-url"

const access = {
  sessionId: "session-billing",
  artifactId: "artifact/preview 1",
  revision: 3,
  purpose: "preview" as const,
  expiresAt: 1_760_000_000_000,
  signature: "sig",
}

describe("artifactUrlFor", () => {
  it("fetches over the same protection the socket has", () => {
    expect(artifactUrlFor("wss://mac.tailnet.ts.net:47831/rpc", access)).toMatch(/^https:\/\/mac\.tailnet\.ts\.net:47831\/artifacts\//)
    expect(artifactUrlFor("ws://127.0.0.1:47831/rpc", access)).toMatch(/^http:\/\/127\.0\.0\.1:47831\/artifacts\//)
  })

  it("names the artifact in the path and carries the grant in the query", () => {
    const url = new URL(artifactUrlFor("wss://mac.tailnet.ts.net:47831/rpc", access))
    expect(url.pathname).toBe("/artifacts/artifact%2Fpreview%201")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      session: "session-billing",
      revision: "3",
      purpose: "preview",
      expires: "1760000000000",
      signature: "sig",
    })
    expect(url.hash).toBe("")
  })
})
