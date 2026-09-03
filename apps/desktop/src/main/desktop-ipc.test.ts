import { describe, expect, it, vi, type Mock } from "vitest"

import {
  registerDesktopIpc,
  type DesktopDeepLinkSink,
  type DesktopIpcDependencies,
  type DesktopIpcEvent,
  type DesktopIpcMain,
  type DesktopIpcWindow,
} from "./desktop-ipc.js"

type DesktopIpcListener = (event: DesktopIpcEvent, ...args: unknown[]) => unknown

type Registration = "handle" | "on"

type UnauthorizedOutcome =
  | { rejects: string }
  | { returns: unknown }
  | { ignored: true }
  | { exits: true }

type ChannelSpec = {
  channel: string
  via: Registration
  guard: "authorized" | "sender-identity"
  unauthorized: UnauthorizedOutcome
  argument?: unknown
}

const notAuthorized = "Desktop request is not authorized"
const rect = { x: 0, y: 0, width: 10, height: 10 }
const notification = { id: "desktop-completion-0123456789abcdef", kind: "completion", sessionId: "session-one" }
const externalRequest = { editor: "system", path: "/home/user/.domovoi/worktrees/project" }

const channels: readonly ChannelSpec[] = [
  { channel: "window:minimize", via: "on", guard: "authorized", unauthorized: { ignored: true } },
  { channel: "window:maximize", via: "on", guard: "authorized", unauthorized: { ignored: true } },
  { channel: "window:close", via: "on", guard: "authorized", unauthorized: { ignored: true } },
  { channel: "domovoi:rpc-token", via: "handle", guard: "authorized", unauthorized: { rejects: notAuthorized } },
  {
    channel: "domovoi:capture-annotation",
    via: "handle",
    guard: "authorized",
    unauthorized: { rejects: "Annotation capture sender is not authorized" },
    argument: rect,
  },
  {
    channel: "domovoi:notify",
    via: "handle",
    guard: "authorized",
    unauthorized: { returns: false },
    argument: notification,
  },
  { channel: "domovoi:open-directory", via: "handle", guard: "authorized", unauthorized: { rejects: notAuthorized } },
  { channel: "domovoi:clipboard-read", via: "handle", guard: "authorized", unauthorized: { rejects: notAuthorized } },
  {
    channel: "domovoi:clipboard-write",
    via: "handle",
    guard: "authorized",
    unauthorized: { rejects: notAuthorized },
    argument: "copy me",
  },
  {
    channel: "domovoi:open-external",
    via: "handle",
    guard: "authorized",
    unauthorized: { rejects: notAuthorized },
    argument: externalRequest,
  },
  { channel: "domovoi:deep-link-ready", via: "on", guard: "authorized", unauthorized: { ignored: true } },
  { channel: "domovoi:deep-link-paused", via: "on", guard: "authorized", unauthorized: { ignored: true } },
  {
    channel: "domovoi:launch-smoke-preload-ready",
    via: "on",
    guard: "sender-identity",
    unauthorized: { ignored: true },
  },
  { channel: "domovoi:launch-smoke-ready", via: "on", guard: "authorized", unauthorized: { exits: true } },
]

function capturedImage() {
  return {
    getSize: () => ({ width: 10, height: 10 }),
    resize: vi.fn(),
    toPNG: () => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]),
  }
}

function harness(options: { authorized?: boolean; launchSmoke?: boolean; withWindow?: boolean } = {}) {
  let authorized = options.authorized ?? true
  let sink: DesktopDeepLinkSink | undefined
  const registrations: [Registration, string][] = []
  const handlers = new Map<string, DesktopIpcListener>()
  const listeners = new Map<string, DesktopIpcListener>()
  const ipcMain: DesktopIpcMain = {
    handle: (channel, listener) => {
      registrations.push(["handle", channel])
      handlers.set(channel, listener)
    },
    on: (channel, listener) => {
      registrations.push(["on", channel])
      listeners.set(channel, listener)
    },
  }
  const webContents = {
    capturePage: vi.fn(async () => capturedImage()),
    send: vi.fn(),
  }
  const window: DesktopIpcWindow & { isDestroyed: Mock<() => boolean>; isMaximized: Mock<() => boolean> } = {
    webContents,
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
  }
  const event: DesktopIpcEvent = { sender: { send: vi.fn() }, senderFrame: null }
  const effects = {
    "window.minimize": window.minimize as Mock,
    "window.maximize": window.maximize as Mock,
    "window.unmaximize": window.unmaximize as Mock,
    "window.close": window.close as Mock,
    "webContents.capturePage": webContents.capturePage,
    "webContents.send": webContents.send,
    "event.sender.send": event.sender.send as Mock,
    focusMainWindow: vi.fn(),
    "openDirectoryDialog.showOpenDirectory": vi.fn(async () => ({ canceled: false, filePaths: ["/projects/app"] })),
    "clipboard.readText": vi.fn(async () => "pasted"),
    "clipboard.writeText": vi.fn(async () => true),
    "externalTargets.allowRoot": vi.fn(),
    "externalTargets.open": vi.fn(async () => true),
    "notifications.notify": vi.fn((_input: unknown, _activate: (sessionId: string) => void) => true),
    "deepLinks.enqueue": vi.fn(),
    "deepLinks.ready": vi.fn(),
    "deepLinks.pause": vi.fn(),
    "rendererDeepLinkSink.set": vi.fn((next: DesktopDeepLinkSink | undefined) => { sink = next }),
    "launchSmoke.preloadReady": vi.fn(),
    "launchSmoke.ready": vi.fn(),
    "launchSmoke.unauthorized": vi.fn(),
  } satisfies Record<string, Mock>
  const authorize = vi.fn((_event: DesktopIpcEvent) => authorized)
  const deps: DesktopIpcDependencies = {
    authorized: authorize,
    mainWindow: () => (options.withWindow ?? true) ? window : undefined,
    focusMainWindow: effects.focusMainWindow,
    rpcToken: "rpc-token-value",
    platform: "linux",
    fileSystem: {
      realpath: async (path) => path,
      stat: async () => ({ isDirectory: () => true, isFile: () => false }),
    },
    openDirectoryDialog: { showOpenDirectory: effects["openDirectoryDialog.showOpenDirectory"] },
    clipboard: { readText: effects["clipboard.readText"], writeText: effects["clipboard.writeText"] },
    externalTargets: { allowRoot: effects["externalTargets.allowRoot"], open: effects["externalTargets.open"] },
    notifications: { notify: effects["notifications.notify"] },
    deepLinks: {
      enqueue: effects["deepLinks.enqueue"],
      ready: effects["deepLinks.ready"],
      pause: effects["deepLinks.pause"],
    },
    rendererDeepLinkSink: { get: () => sink, set: effects["rendererDeepLinkSink.set"] },
    launchSmoke: {
      enabled: options.launchSmoke ?? true,
      preloadReady: effects["launchSmoke.preloadReady"],
      ready: effects["launchSmoke.ready"],
      unauthorized: effects["launchSmoke.unauthorized"],
    },
  }
  registerDesktopIpc(ipcMain, deps)
  return {
    registrations,
    window,
    event,
    effects,
    authorize,
    setAuthorized: (value: boolean) => { authorized = value },
    sink: () => sink,
    listener: (via: Registration, channel: string): DesktopIpcListener => {
      const listener = (via === "handle" ? handlers : listeners).get(channel)
      if (!listener) throw new Error(`${channel} was not registered via ipcMain.${via}`)
      return listener
    },
    calledEffects: () => Object.entries(effects)
      .filter(([, spy]) => spy.mock.calls.length > 0)
      .map(([name]) => name),
  }
}

describe("registerDesktopIpc", () => {
  it("registers exactly the documented channels", () => {
    const target = harness()
    const expected = channels.map((spec) => [spec.via, spec.channel] as const)
    expect([...target.registrations].sort()).toEqual([...expected].sort())
  })

  describe("rejects an unauthorized sender on", () => {
    it.each(channels)("$channel", async (spec) => {
      const target = harness({ authorized: false })
      const listener = target.listener(spec.via, spec.channel)
      const outcome = spec.unauthorized

      if ("rejects" in outcome) {
        await expect(async () => listener(target.event, spec.argument)).rejects.toThrow(outcome.rejects)
      } else if ("returns" in outcome) {
        expect(await listener(target.event, spec.argument)).toBe(outcome.returns)
      } else {
        expect(listener(target.event, spec.argument)).toBeUndefined()
      }

      expect(target.calledEffects()).toEqual("exits" in outcome ? ["launchSmoke.unauthorized"] : [])
      if (spec.guard === "authorized") expect(target.authorize).toHaveBeenCalledWith(target.event)
      else expect(target.authorize).not.toHaveBeenCalled()
    })
  })

  it("launch-smoke-preload-ready trusts only the main window webContents and never consults the guard", () => {
    const target = harness({ authorized: false })
    const listener = target.listener("on", "domovoi:launch-smoke-preload-ready")

    listener(target.event)
    expect(target.effects["launchSmoke.preloadReady"]).not.toHaveBeenCalled()

    listener({ sender: target.window.webContents, senderFrame: null })
    expect(target.effects["launchSmoke.preloadReady"]).toHaveBeenCalledOnce()
    expect(target.authorize).not.toHaveBeenCalled()

    const disabled = harness({ launchSmoke: false })
    disabled.listener("on", "domovoi:launch-smoke-preload-ready")({ sender: disabled.window.webContents, senderFrame: null })
    expect(disabled.effects["launchSmoke.preloadReady"]).not.toHaveBeenCalled()
  })

  it("serves the authorized renderer", async () => {
    const target = harness()

    expect(target.listener("handle", "domovoi:rpc-token")(target.event)).toBe("rpc-token-value")
    expect(await target.listener("handle", "domovoi:clipboard-read")(target.event)).toBe("pasted")
    expect(await target.listener("handle", "domovoi:clipboard-write")(target.event, "copy me")).toBe(true)
    expect(target.effects["clipboard.writeText"]).toHaveBeenCalledWith("copy me")
    expect(await target.listener("handle", "domovoi:open-external")(target.event, externalRequest)).toBe(true)
    expect(target.effects["externalTargets.open"]).toHaveBeenCalledWith(externalRequest)

    const capture = await target.listener("handle", "domovoi:capture-annotation")(target.event, rect)
    expect(target.effects["webContents.capturePage"]).toHaveBeenCalledWith(rect)
    expect(capture).toMatchObject({ mimeType: "image/png", width: 10, height: 10 })

    expect(await target.listener("handle", "domovoi:open-directory")(target.event))
      .toEqual({ status: "selected", path: "/projects/app" })
    expect(target.effects["externalTargets.allowRoot"]).toHaveBeenCalledWith("/projects/app")

    target.listener("on", "window:minimize")(target.event)
    target.listener("on", "window:close")(target.event)
    expect(target.effects["window.minimize"]).toHaveBeenCalledOnce()
    expect(target.effects["window.close"]).toHaveBeenCalledOnce()
  })

  it("toggles maximize against the current window state", () => {
    const target = harness()
    const maximize = target.listener("on", "window:maximize")

    maximize(target.event)
    expect(target.effects["window.maximize"]).toHaveBeenCalledOnce()
    expect(target.effects["window.unmaximize"]).not.toHaveBeenCalled()

    target.window.isMaximized.mockReturnValue(true)
    maximize(target.event)
    expect(target.effects["window.unmaximize"]).toHaveBeenCalledOnce()
  })

  it("refuses capture and directory dialogs while no main window exists", async () => {
    const target = harness({ withWindow: false })

    await expect(target.listener("handle", "domovoi:capture-annotation")(target.event, rect))
      .rejects.toThrow("Annotation capture sender is not authorized")
    await expect(target.listener("handle", "domovoi:open-directory")(target.event))
      .rejects.toThrow(notAuthorized)
    expect(target.calledEffects()).toEqual([])
  })

  it("activates notifications by focusing the live main window", async () => {
    const target = harness()
    const notify = target.listener("handle", "domovoi:notify")

    expect(await notify(target.event, notification)).toBe(true)
    expect(target.effects["notifications.notify"]).toHaveBeenCalledWith(notification, expect.any(Function))
    const activate = target.effects["notifications.notify"].mock.calls[0]?.[1]
    expect(activate).toBeTypeOf("function")

    activate?.("session-one")
    expect(target.effects.focusMainWindow).toHaveBeenCalledOnce()
    expect(target.effects["webContents.send"]).toHaveBeenCalledWith("domovoi:notification-activate", "session-one")

    target.window.isDestroyed.mockReturnValue(true)
    activate?.("session-two")
    expect(target.effects.focusMainWindow).toHaveBeenCalledOnce()
    expect(target.effects["webContents.send"]).toHaveBeenCalledOnce()
  })

  it("re-checks authorization for every delivered deep link", () => {
    const target = harness()
    const link = { kind: "session", sessionId: "session-one" } as const
    const previous: DesktopDeepLinkSink = () => {}
    target.effects["rendererDeepLinkSink.set"](previous)

    target.listener("on", "domovoi:deep-link-ready")(target.event)
    expect(target.effects["deepLinks.pause"]).toHaveBeenCalledWith(previous)
    const sink = target.sink()
    expect(sink).toBeDefined()
    expect(sink).not.toBe(previous)
    expect(target.effects["deepLinks.ready"]).toHaveBeenCalledWith(sink)

    sink?.(link)
    expect(target.effects["event.sender.send"]).toHaveBeenCalledWith("domovoi:deep-link", "session-one")

    target.setAuthorized(false)
    sink?.(link)
    expect(target.effects["event.sender.send"]).toHaveBeenCalledOnce()
    expect(target.effects["deepLinks.pause"]).toHaveBeenLastCalledWith(sink)
    expect(target.sink()).toBeUndefined()
    expect(target.effects["deepLinks.enqueue"]).toHaveBeenCalledWith(link)
  })

  it("pauses the renderer sink only while one is registered", () => {
    const target = harness()
    const paused = target.listener("on", "domovoi:deep-link-paused")

    paused(target.event)
    expect(target.calledEffects()).toEqual([])

    target.listener("on", "domovoi:deep-link-ready")(target.event)
    const sink = target.sink()
    paused(target.event)
    expect(target.effects["deepLinks.pause"]).toHaveBeenLastCalledWith(sink)
    expect(target.sink()).toBeUndefined()
  })

  it("completes the launch smoke only for an authorized renderer while smoke mode is on", () => {
    const target = harness()
    target.listener("on", "domovoi:launch-smoke-ready")(target.event)
    expect(target.calledEffects()).toEqual(["launchSmoke.ready"])

    const disabled = harness({ authorized: false, launchSmoke: false })
    disabled.listener("on", "domovoi:launch-smoke-ready")(disabled.event)
    expect(disabled.calledEffects()).toEqual([])
    expect(disabled.authorize).not.toHaveBeenCalled()
  })
})
