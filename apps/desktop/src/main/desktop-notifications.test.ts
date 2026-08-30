import { describe, expect, it, vi } from "vitest"

import {
  DesktopNotificationController,
  desktopNotificationCopy,
  type NativeNotificationAdapter,
  type NativeNotificationHandle,
} from "./desktop-notifications.js"

function adapter() {
  const listeners = new Map<string, () => void>()
  const handle: NativeNotificationHandle = {
    once: vi.fn((event, listener) => { listeners.set(event, listener) }),
    show: vi.fn(),
  }
  const native: NativeNotificationAdapter = {
    isSupported: vi.fn(() => true),
    create: vi.fn(() => handle),
  }
  return { handle, listeners, native }
}

const request = {
  id: "desktop-completion-0123456789abcdef",
  kind: "completion",
  sessionId: "session-one",
} as const

describe("DesktopNotificationController", () => {
  it("shows bounded fixed copy and activates only the validated session on click", () => {
    const target = adapter()
    const activate = vi.fn()
    const controller = new DesktopNotificationController(target.native)

    expect(controller.notify(request, activate)).toBe(true)
    expect(target.native.create).toHaveBeenCalledWith(desktopNotificationCopy.completion)
    expect(target.handle.show).toHaveBeenCalledOnce()

    target.listeners.get("click")?.()
    expect(activate).toHaveBeenCalledWith("session-one")
  })

  it("deduplicates IDs and rejects malformed or detail-bearing requests", () => {
    const target = adapter()
    const controller = new DesktopNotificationController(target.native)

    expect(controller.notify(request, vi.fn())).toBe(true)
    expect(controller.notify(request, vi.fn())).toBe(false)
    expect(controller.notify({ ...request, command: "TOKEN=secret" }, vi.fn())).toBe(false)
    expect(controller.notify({ ...request, sessionId: "../private/path" }, vi.fn())).toBe(false)
    expect(target.native.create).toHaveBeenCalledTimes(1)
  })

  it("does nothing when unsupported and absorbs native failures", () => {
    const unsupported = adapter()
    unsupported.native.isSupported = vi.fn(() => false)
    expect(new DesktopNotificationController(unsupported.native).notify(request, vi.fn())).toBe(false)

    const failing = adapter()
    failing.native.create = vi.fn(() => { throw new Error("permission denied") })
    expect(() => new DesktopNotificationController(failing.native).notify(request, vi.fn())).not.toThrow()
  })

  it("absorbs failures from support checks, display, and click activation", () => {
    const supportFailure = adapter()
    supportFailure.native.isSupported = vi.fn(() => { throw new Error("unsupported") })
    expect(() => new DesktopNotificationController(supportFailure.native).notify(request, vi.fn())).not.toThrow()

    const showFailure = adapter()
    showFailure.handle.show = vi.fn(() => { throw new Error("display failed") })
    expect(() => new DesktopNotificationController(showFailure.native).notify(request, vi.fn())).not.toThrow()

    const clickFailure = adapter()
    new DesktopNotificationController(clickFailure.native).notify(request, () => { throw new Error("closed") })
    expect(() => clickFailure.listeners.get("click")?.()).not.toThrow()
  })
})
