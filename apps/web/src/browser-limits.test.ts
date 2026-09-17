import { describe, expect, it } from "vitest"

import { browserLimits, type BrowserLimitRow } from "./browser-limits"
import type { BrowserPlatformEnvironment } from "./browser-platform"
import { browserRefusalMessage } from "./platform-refusals"

function environment(overrides: Partial<BrowserPlatformEnvironment> = {}): BrowserPlatformEnvironment {
  return {
    secureContext: true,
    notifications: undefined,
    clipboard: undefined,
    install: { homeScreenOnly: false, installed: () => false, promptable: () => false, prompt: async () => {} },
    ...overrides,
  }
}

function row(rows: BrowserLimitRow[], what: string): BrowserLimitRow {
  const found = rows.find((candidate) => candidate.what === what)
  if (!found) throw new Error(`no row for ${what}`)
  return found
}

describe("browserLimits", () => {
  it("says what is the same as the desktop over the route, and why", () => {
    const rows = browserLimits(environment(), "ws://127.0.0.1:47831/rpc", true)
    for (const what of ["Watch a session live", "Answer a gate", "Read diffs", "Terminal"]) {
      expect(row(rows, what)).toMatchObject({ state: "same as desktop", tone: "same" })
    }
    expect(row(rows, "Terminal").why).toMatch(/loopback/)
    expect(row(browserLimits(environment(), "wss://mac.ts.net:47831/rpc", true), "Terminal").why).toMatch(/tailnet/)
  })

  it("reports notifications as this browser actually has them", () => {
    const none = browserLimits(environment(), "ws://127.0.0.1:47831/rpc", true)
    expect(row(none, "Notifications")).toMatchObject({ state: "refused", tone: "refused", why: browserRefusalMessage["notifications-unsupported"] })

    const denied = browserLimits(environment({
      notifications: { permission: () => "denied", request: async () => undefined, show: () => {} },
    }), "ws://127.0.0.1:47831/rpc", true)
    expect(row(denied, "Notifications")).toMatchObject({ state: "refused", why: browserRefusalMessage["notifications-denied"] })

    const askable = browserLimits(environment({
      notifications: { permission: () => "default", request: async () => undefined, show: () => {} },
    }), "ws://127.0.0.1:47831/rpc", true)
    expect(row(askable, "Notifications")).toMatchObject({ state: "asks first", tone: "conditional" })

    const granted = browserLimits(environment({
      notifications: { permission: () => "granted", request: async () => undefined, show: () => {} },
    }), "ws://127.0.0.1:47831/rpc", true)
    expect(row(granted, "Notifications")).toMatchObject({ state: "same as desktop", tone: "same" })
  })

  it("reports the clipboard, the folder picker and install as they really are", () => {
    const plain = browserLimits(environment(), "http://127.0.0.1:5178/rpc", true)
    expect(row(plain, "Copy to the clipboard")).toMatchObject({ state: "refused", why: browserRefusalMessage["clipboard-unsupported"] })
    expect(row(plain, "Choose a folder")).toMatchObject({ state: "type the path", tone: "conditional", why: browserRefusalMessage["dialogs-unsupported"] })
    expect(row(plain, "Install as an app")).toMatchObject({ state: "from the browser menu", tone: "conditional" })

    const insecure = browserLimits(environment({ secureContext: false, clipboard: { writeText: async () => {} } }), "ws://10.0.0.2:47831/rpc", true)
    expect(row(insecure, "Copy to the clipboard")).toMatchObject({ state: "refused", why: browserRefusalMessage["clipboard-insecure-context"] })

    const installed = browserLimits(environment({
      clipboard: { writeText: async () => {} },
      install: { homeScreenOnly: false, installed: () => true, promptable: () => false, prompt: async () => {} },
    }), "ws://127.0.0.1:47831/rpc", true)
    expect(row(installed, "Copy to the clipboard")).toMatchObject({ state: "same as desktop" })
    expect(row(installed, "Install as an app")).toMatchObject({ state: "installed", tone: "same" })
  })

  it("names what a tab never does, and where its credential lives", () => {
    const rows = browserLimits(environment(), "ws://127.0.0.1:47831/rpc", true)
    expect(row(rows, "Open the repository")).toMatchObject({ state: "not possible", tone: "never" })
    expect(row(rows, "Attach a local file")).toMatchObject({ state: "not yet", tone: "conditional" })
    expect(row(rows, "Hold the credential")).toMatchObject({ state: "this tab only", tone: "conditional" })

    const blocked = browserLimits(environment(), "ws://127.0.0.1:47831/rpc", false)
    expect(row(blocked, "Hold the credential")).toMatchObject({ state: "refused", tone: "refused", why: browserRefusalMessage["credentials-unavailable"] })
  })

  it("names the route only when it can read it, and the install prompt when the browser offers one", () => {
    const unreadable = browserLimits(environment(), "not a url", true)
    expect(row(unreadable, "Terminal").why).toMatch(/on the route,/)

    const promptable = browserLimits(environment({
      install: { homeScreenOnly: false, installed: () => false, promptable: () => true, prompt: async () => {} },
    }), "ws://127.0.0.1:47831/rpc", true)
    expect(row(promptable, "Install as an app")).toMatchObject({ state: "one prompt away", tone: "conditional" })

    const homeScreen = browserLimits(environment({
      install: { homeScreenOnly: true, installed: () => false, promptable: () => false, prompt: async () => {} },
    }), "ws://127.0.0.1:47831/rpc", true)
    expect(row(homeScreen, "Notifications")).toMatchObject({ why: browserRefusalMessage["notifications-requires-install"] })
  })
})
