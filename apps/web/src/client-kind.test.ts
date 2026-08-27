import { describe, expect, it } from "vitest"

import { clientKindForBrowser } from "./client-kind"

describe("clientKindForBrowser", () => {
  it("recognizes iPadOS desktop user agents in split view", () => {
    expect(clientKindForBrowser({
      coarsePointer: false,
      maxTouchPoints: 5,
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
      viewportWidth: 600,
    })).toBe("tablet")
  })

  it("distinguishes Android phones from tablets", () => {
    const base = {
      coarsePointer: true,
      maxTouchPoints: 5,
      platform: "Linux armv8l",
      viewportWidth: 800,
    }

    expect(clientKindForBrowser({ ...base, userAgent: "Mozilla/5.0 (Linux; Android 16; Mobile)" })).toBe("phone")
    expect(clientKindForBrowser({ ...base, userAgent: "Mozilla/5.0 (Linux; Android 16)" })).toBe("tablet")
  })

  it("keeps narrow desktop browsers classified as web clients", () => {
    expect(clientKindForBrowser({
      coarsePointer: false,
      maxTouchPoints: 0,
      platform: "Linux x86_64",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      viewportWidth: 390,
    })).toBe("web")
  })

  it("uses touch capability and width when the user agent is ambiguous", () => {
    const base = {
      coarsePointer: true,
      maxTouchPoints: 10,
      platform: "Linux",
      userAgent: "reduced",
    }

    expect(clientKindForBrowser({ ...base, viewportWidth: 390 })).toBe("phone")
    expect(clientKindForBrowser({ ...base, viewportWidth: 1024 })).toBe("tablet")
  })
})
