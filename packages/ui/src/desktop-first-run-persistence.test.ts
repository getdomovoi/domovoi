import { describe, expect, it, vi } from "vitest"

import {
  completeDesktopFirstRun,
  defaultDesktopFirstRunState,
  desktopFirstRunStorageKey,
  loadDesktopFirstRunState,
  resetDesktopFirstRunState,
  saveDesktopFirstRunState,
} from "./desktop-first-run-persistence.js"

function memoryStorage(initial?: string) {
  let value = initial ?? null
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => { value = next }),
    removeItem: vi.fn(() => { value = null }),
    value: () => value,
  }
}

describe("desktop first-run persistence", () => {
  it("stores only a versioned provider preference and Build manual completion", () => {
    const storage = memoryStorage()
    const completed = completeDesktopFirstRun({
      providerId: "codex",
      permissionMode: "build",
      completedAt: "2026-08-30T12:00:00.000Z",
    })

    saveDesktopFirstRunState(storage, completed)

    expect(loadDesktopFirstRunState(storage)).toEqual(completed)
    expect(storage.setItem).toHaveBeenCalledWith(desktopFirstRunStorageKey, expect.any(String))
    expect(storage.value()).not.toMatch(/credential|password|secret|token/i)
    expect(storage.value()).toContain('"auto":false')
    expect(completeDesktopFirstRun({
      providerId: "codex",
      completedAt: "2026-08-30T12:00:00.000Z",
    })).toMatchObject({ permissionMode: "build", auto: false })
  })

  it.each([
    ["invalid JSON", "{"],
    ["unknown version", JSON.stringify({ version: 2, status: "complete" })],
    ["unknown status", JSON.stringify({ version: 1, status: "skipped" })],
    ["invalid provider", JSON.stringify({
      version: 1,
      status: "complete",
      providerId: "../../credential",
      permissionMode: "build",
      auto: false,
      completedAt: "2026-08-30T12:00:00.000Z",
    })],
    ["credential-shaped extra data", JSON.stringify({
      version: 1,
      status: "complete",
      providerId: "codex",
      permissionMode: "build",
      auto: false,
      completedAt: "2026-08-30T12:00:00.000Z",
      token: "forbidden",
    })],
  ])("recovers safely from %s", (_label, raw) => {
    expect(loadDesktopFirstRunState(memoryStorage(raw))).toEqual(defaultDesktopFirstRunState())
  })

  it("resets completion without failing when storage is unavailable", () => {
    const storage = memoryStorage(JSON.stringify(completeDesktopFirstRun({
      providerId: "claude-code",
      permissionMode: "plan",
      completedAt: "2026-08-30T12:00:00.000Z",
    })))

    resetDesktopFirstRunState(storage)
    expect(storage.removeItem).toHaveBeenCalledWith(desktopFirstRunStorageKey)
    expect(loadDesktopFirstRunState(storage)).toEqual(defaultDesktopFirstRunState())

    const unavailable = {
      getItem: vi.fn(() => { throw new DOMException("blocked") }),
      setItem: vi.fn(() => { throw new DOMException("full") }),
      removeItem: vi.fn(() => { throw new DOMException("blocked") }),
    }
    expect(loadDesktopFirstRunState(unavailable)).toEqual(defaultDesktopFirstRunState())
    expect(() => saveDesktopFirstRunState(unavailable, defaultDesktopFirstRunState())).not.toThrow()
    expect(() => resetDesktopFirstRunState(unavailable)).not.toThrow()
  })
})
