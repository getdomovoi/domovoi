import { describe, expect, it, vi } from "vitest"

import {
  browserPlatformEnvironment,
  createBrowserPlatform,
  type BrowserGlobals,
  type BrowserNotificationPermission,
  type BrowserPlatformEnvironment,
} from "./browser-platform"
import { browserRefusalMessage, BrowserCapabilityError } from "./platform-refusals"

function environment(overrides: Partial<BrowserPlatformEnvironment> = {}): BrowserPlatformEnvironment {
  return {
    secureContext: true,
    notifications: undefined,
    clipboard: undefined,
    install: { homeScreenOnly: false, installed: () => false, promptable: () => false, prompt: async () => {} },
    ...overrides,
  }
}

function notificationHost(permission: BrowserNotificationPermission) {
  const raised: { title: string; body: string; tag: string }[] = []
  let current = permission
  return {
    raised,
    grant: (next: BrowserNotificationPermission) => { current = next },
    host: {
      permission: () => current,
      request: vi.fn(async () => current),
      show: (options: { title: string; body: string; tag: string }) => { raised.push(options) },
    },
  }
}

const completion = { id: "desktop-completion-0123456789abcdef", kind: "completion" as const, sessionId: "session-1" }

describe("browser dialogs", () => {
  it("refuses a project picker rather than resolving the wrong filesystem", async () => {
    const platform = createBrowserPlatform(environment())

    await expect(platform.dialogs.pickProjectDirectory()).resolves.toEqual({
      status: "refused",
      message: "A browser cannot open a folder picker on the execution machine, so type the repository path instead.",
    })
  })
})

describe("browser notifications", () => {
  it("raises the granted kind with copy that carries no session content", async () => {
    const notifications = notificationHost("granted")
    const platform = createBrowserPlatform(environment({ notifications: notifications.host }))

    expect(platform.notifications.delivery()).toEqual({ status: "ready" })
    await platform.notifications.notify(completion)
    await platform.notifications.notify({ ...completion, kind: "failure" })
    await platform.notifications.notify({ ...completion, kind: "approval-needed" })

    expect(notifications.raised).toEqual([
      { title: "Domovoi finished", body: "Agent work completed. Open Domovoi to review it.", tag: completion.id },
      { title: "Domovoi needs attention", body: "Agent work failed. Open Domovoi to review recovery options.", tag: completion.id },
      { title: "Approval needed", body: "Agent work is waiting for your decision in Domovoi.", tag: completion.id },
    ])
  })

  it("reports an unasked browser as askable and never raises silently", async () => {
    const notifications = notificationHost("default")
    const platform = createBrowserPlatform(environment({ notifications: notifications.host }))

    expect(platform.notifications.delivery()).toEqual({ status: "askable" })
    await expect(platform.notifications.notify(completion)).rejects.toThrow(BrowserCapabilityError)
    await expect(platform.notifications.notify(completion)).rejects.toThrow(
      browserRefusalMessage["notifications-not-allowed"],
    )
    expect(notifications.raised).toEqual([])
  })

  it("becomes ready once the browser answers the permission request", async () => {
    const notifications = notificationHost("default")
    notifications.host.request = vi.fn(async () => {
      notifications.grant("granted")
      return "granted" as const
    })
    const platform = createBrowserPlatform(environment({ notifications: notifications.host }))

    await expect(platform.notifications.request()).resolves.toEqual({ status: "ready" })
    await platform.notifications.notify(completion)
    expect(notifications.raised).toHaveLength(1)
  })

  it("names a blocked browser instead of dropping the event", async () => {
    const notifications = notificationHost("denied")
    const platform = createBrowserPlatform(environment({ notifications: notifications.host }))

    expect(platform.notifications.delivery()).toEqual({
      status: "refused",
      message: browserRefusalMessage["notifications-denied"],
    })
    await expect(platform.notifications.notify(completion)).rejects.toThrow(
      browserRefusalMessage["notifications-denied"],
    )
    await expect(platform.notifications.request()).resolves.toEqual({
      status: "refused",
      message: browserRefusalMessage["notifications-denied"],
    })
  })

  it("treats a thrown permission request as a refusal", async () => {
    const notifications = notificationHost("default")
    notifications.host.request = vi.fn(async () => { throw new Error("not allowed here") })
    const platform = createBrowserPlatform(environment({ notifications: notifications.host }))

    await expect(platform.notifications.request()).resolves.toEqual({
      status: "refused",
      message: browserRefusalMessage["notifications-denied"],
    })
  })

  it("separates a browser with no Notifications API from one that needs the app installed", async () => {
    const missing = createBrowserPlatform(environment())
    const homeScreen = createBrowserPlatform(environment({
      install: { homeScreenOnly: true, installed: () => false, promptable: () => false, prompt: async () => {} },
    }))
    const installedHomeScreen = createBrowserPlatform(environment({
      install: { homeScreenOnly: true, installed: () => true, promptable: () => false, prompt: async () => {} },
    }))

    expect(missing.notifications.delivery()).toEqual({
      status: "refused",
      message: browserRefusalMessage["notifications-unsupported"],
    })
    expect(homeScreen.notifications.delivery()).toEqual({
      status: "refused",
      message: browserRefusalMessage["notifications-requires-install"],
    })
    expect(installedHomeScreen.notifications.delivery()).toEqual({
      status: "refused",
      message: browserRefusalMessage["notifications-unsupported"],
    })
    await expect(missing.notifications.request()).resolves.toEqual({
      status: "refused",
      message: browserRefusalMessage["notifications-unsupported"],
    })
    await expect(missing.notifications.notify(completion)).rejects.toThrow(
      browserRefusalMessage["notifications-unsupported"],
    )
  })
})

describe("browser clipboard", () => {
  it("writes through the browser clipboard on a secure origin", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const platform = createBrowserPlatform(environment({ clipboard: { writeText } }))

    await platform.clipboard.writeText("/home/dev/src/api")

    expect(writeText).toHaveBeenCalledWith("/home/dev/src/api")
  })

  it("names the origin, the missing API and a refusal apart", async () => {
    const insecure = createBrowserPlatform(environment({
      secureContext: false,
      clipboard: { writeText: vi.fn() },
    }))
    const missing = createBrowserPlatform(environment())
    const refused = createBrowserPlatform(environment({
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) },
    }))

    await expect(insecure.clipboard.writeText("value")).rejects.toThrow(
      browserRefusalMessage["clipboard-insecure-context"],
    )
    await expect(missing.clipboard.writeText("value")).rejects.toThrow(
      browserRefusalMessage["clipboard-unsupported"],
    )
    await expect(refused.clipboard.writeText("value")).rejects.toThrow(
      browserRefusalMessage["clipboard-denied"],
    )
  })
})

describe("browser install state", () => {
  it("reports an installed client", () => {
    const platform = createBrowserPlatform(environment({
      install: { homeScreenOnly: false, installed: () => true, promptable: () => false, prompt: async () => {} },
    }))

    expect(platform.install.state()).toEqual({ status: "installed" })
  })

  it("prompts once and reports the state the browser reached", async () => {
    let installed = false
    const prompt = vi.fn(async () => { installed = true })
    const platform = createBrowserPlatform(environment({
      install: {
        homeScreenOnly: false,
        installed: () => installed,
        promptable: () => !installed,
        prompt,
      },
    }))

    expect(platform.install.state()).toEqual({ status: "installable" })
    await expect(platform.install.prompt()).resolves.toEqual({ status: "installed" })
    expect(prompt).toHaveBeenCalledOnce()
  })

  it("keeps its state when the browser refuses the prompt", async () => {
    const platform = createBrowserPlatform(environment({
      install: {
        homeScreenOnly: false,
        installed: () => false,
        promptable: () => true,
        prompt: async () => { throw new Error("prompt already used") },
      },
    }))

    await expect(platform.install.prompt()).resolves.toEqual({ status: "installable" })
  })

  it("names the manual route where the browser offers no prompt", async () => {
    const platform = createBrowserPlatform(environment())

    expect(platform.install.state()).toEqual({
      status: "manual",
      message: browserRefusalMessage["install-unsupported"],
    })
    await expect(platform.install.prompt()).resolves.toEqual({
      status: "manual",
      message: browserRefusalMessage["install-unsupported"],
    })
  })
})

type Listener = (event: Event) => void

function fakeGlobals(overrides: Partial<BrowserGlobals> = {}) {
  const listeners = new Map<string, Listener[]>()
  const focus = vi.fn()
  const globals: BrowserGlobals = {
    isSecureContext: true,
    navigator: {},
    matchMedia: () => ({ matches: false }),
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    focus,
    ...overrides,
  }
  const emit = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event as Event)
  }
  return { globals, emit, focus }
}

describe("browser environment", () => {
  it("reads a plain browser tab as uninstalled with no install prompt", () => {
    const { globals } = fakeGlobals()

    const resolved = browserPlatformEnvironment(globals)

    expect(resolved.secureContext).toBe(true)
    expect(resolved.notifications).toBeUndefined()
    expect(resolved.clipboard).toBeUndefined()
    expect(resolved.install.homeScreenOnly).toBe(false)
    expect(resolved.install.installed()).toBe(false)
    expect(resolved.install.promptable()).toBe(false)
  })

  it("reads a standalone display mode and an iOS home screen host", () => {
    const standalone = browserPlatformEnvironment(fakeGlobals({
      matchMedia: () => ({ matches: true }),
    }).globals)
    const ios = browserPlatformEnvironment(fakeGlobals({
      navigator: { standalone: true },
    }).globals)

    expect(standalone.install.installed()).toBe(true)
    expect(ios.install.installed()).toBe(true)
    expect(ios.install.homeScreenOnly).toBe(true)
  })

  it("holds the browser's install prompt until Domovoi asks for it", async () => {
    const { globals, emit } = fakeGlobals()
    const resolved = browserPlatformEnvironment(globals)
    const preventDefault = vi.fn()
    const prompt = vi.fn().mockResolvedValue({ outcome: "accepted" })

    emit("beforeinstallprompt", { preventDefault, prompt })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(resolved.install.promptable()).toBe(true)
    await resolved.install.prompt()
    expect(prompt).toHaveBeenCalledOnce()
    expect(resolved.install.promptable()).toBe(false)
    await resolved.install.prompt()
    expect(prompt).toHaveBeenCalledOnce()
  })

  it("takes the browser's own install as the installed answer", () => {
    const { globals, emit } = fakeGlobals()
    const resolved = browserPlatformEnvironment(globals)
    emit("beforeinstallprompt", { preventDefault: vi.fn(), prompt: vi.fn() })

    emit("appinstalled", {})

    expect(resolved.install.installed()).toBe(true)
    expect(resolved.install.promptable()).toBe(false)
  })

  it("raises through the browser's Notification and focuses the tab on a click", async () => {
    const raised: { title: string; options: { body: string; tag: string }; onclick: unknown }[] = []
    const close = vi.fn()
    const requestPermission = vi.fn().mockResolvedValue("granted")
    class FakeNotification {
      onclick: ((event: Event) => unknown) | null = null
      close = close
      constructor(title: string, options: { body: string; tag: string }) {
        raised.push({ title, options, onclick: null })
        queueMicrotask(() => { raised[raised.length - 1]!.onclick = this.onclick })
      }
      static permission = "granted"
      static requestPermission = requestPermission
    }
    const { globals, focus } = fakeGlobals({
      Notification: FakeNotification,
      navigator: { clipboard: { writeText: vi.fn() } },
    })

    const resolved = browserPlatformEnvironment(globals)

    expect(resolved.clipboard).toBe(globals.navigator.clipboard)
    expect(resolved.notifications?.permission()).toBe("granted")
    await resolved.notifications?.request()
    expect(requestPermission).toHaveBeenCalledOnce()
    resolved.notifications?.show({ title: "Domovoi finished", body: "Agent work completed.", tag: "tag-1" })
    await Promise.resolve()
    const entry = raised[0]
    expect(entry?.title).toBe("Domovoi finished")
    expect(entry?.options).toEqual({ body: "Agent work completed.", tag: "tag-1" })
    ;(entry?.onclick as () => void)()
    expect(focus).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("maps every permission the browser can report", () => {
    for (const [reported, expected] of [
      ["granted", "granted"],
      ["denied", "denied"],
      ["default", "default"],
      ["something-else", "default"],
    ] as const) {
      class FakeNotification {
        onclick: ((event: Event) => unknown) | null = null
        close = vi.fn()
        static permission = reported
        static requestPermission = vi.fn()
      }
      const { globals } = fakeGlobals({ Notification: FakeNotification })
      expect(browserPlatformEnvironment(globals).notifications?.permission()).toBe(expected)
    }
  })
})
