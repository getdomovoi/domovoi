import { describe, expect, it } from "vitest"

import { pickerScript, previewChannel, readSelection, webviewBridgeScript } from "./preview-bridge"

const channel = "channel-0123456789abcdef"

describe("previewChannel", () => {
  it("mints a channel the daemon's schema accepts, and a different one each time", () => {
    const a = previewChannel()
    const b = previewChannel()
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
    expect(a).not.toBe(b)
  })
})

describe("readSelection", () => {
  const selection = {
    type: "domovoi.preview.selection",
    channel,
    artifactId: "artifact-preview",
    anchor: { cssSelector: "main > div:nth-of-type(3)", textQuote: "retried after 15m", bbox: { x: 12, y: 340, width: 300, height: 56 } },
    label: "div · retried after 15m",
  }

  it("reads a selection the bridge posted on this channel", () => {
    expect(readSelection(JSON.stringify(selection), channel, "artifact-preview")).toEqual({
      anchor: selection.anchor,
      label: "div · retried after 15m",
    })
  })

  it("ignores a message on another channel, for another artifact, of another type, or unreadable", () => {
    expect(readSelection(JSON.stringify({ ...selection, channel: "other-channel-0123456789" }), channel, "artifact-preview")).toBeUndefined()
    expect(readSelection(JSON.stringify({ ...selection, artifactId: "artifact-other" }), channel, "artifact-preview")).toBeUndefined()
    expect(readSelection(JSON.stringify({ ...selection, type: "domovoi.preview.picker", active: true }), channel, "artifact-preview")).toBeUndefined()
    expect(readSelection("not json", channel, "artifact-preview")).toBeUndefined()
  })
})

describe("scripts", () => {
  it("forwards only this channel's selection to the native side", () => {
    const script = webviewBridgeScript(channel)
    expect(script).toContain("ReactNativeWebView.postMessage")
    expect(script).toContain(JSON.stringify(channel))
    expect(script).toContain("domovoi.preview.selection")
  })

  it("turns the picker on and off by posting to the page itself", () => {
    expect(pickerScript(channel, true)).toContain('"active":true')
    expect(pickerScript(channel, false)).toContain('"active":false')
    // The sandboxed render has an opaque origin, so only "*" reaches it.
    expect(pickerScript(channel, true)).toContain('"*"')
  })
})
