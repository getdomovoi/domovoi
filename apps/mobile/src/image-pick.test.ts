import { describe, expect, it, vi } from "vitest"

import type { ImageEncoder, PickedImage } from "./attachments"
import { pickAttachment, type ImageSourcePicker } from "./image-pick"

const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const asset: PickedImage = { uri: "file:///picked/IMG_0001.png", fileName: "IMG_0001.png", width: 1, height: 1, base64: png1x1 }
const neverEncode: ImageEncoder = async () => {
  throw new Error("not called for a small clean image")
}

function picker(overrides: Partial<ImageSourcePicker> = {}): ImageSourcePicker {
  return {
    requestCamera: vi.fn(async () => ({ granted: true })),
    launch: vi.fn(async () => ({ canceled: false, assets: [asset] })),
    ...overrides,
  }
}

describe("pickAttachment", () => {
  it("adds what the library hands back, through the same path as a resize", async () => {
    const source = picker()
    expect(await pickAttachment("library", source, neverEncode)).toMatchObject({ kind: "added", attachment: { name: "IMG_0001.png", data: png1x1 } })
    expect(source.requestCamera).not.toHaveBeenCalled()
    expect(source.launch).toHaveBeenCalledWith("library")
  })

  it("asks for the camera before opening it, and opens it only when allowed", async () => {
    const allowed = picker()
    expect(await pickAttachment("camera", allowed, neverEncode)).toMatchObject({ kind: "added" })
    expect(allowed.launch).toHaveBeenCalledWith("camera")

    const refused = picker({ requestCamera: vi.fn(async () => ({ granted: false })) })
    expect(await pickAttachment("camera", refused, neverEncode)).toEqual({
      kind: "problem", text: "This phone has not allowed Domovoi to use the camera.",
    })
    expect(refused.launch).not.toHaveBeenCalled()
  })

  // Walk F23: a picker that fails to open said nothing. Its error is the line.
  it("states a picker that did not open, rather than doing nothing", async () => {
    const library = picker({ launch: vi.fn(async () => { throw new Error("Attempt to present a view controller that is already presenting.") }) })
    expect(await pickAttachment("library", library, neverEncode)).toEqual({
      kind: "problem", text: "The photo library did not open (Attempt to present a view controller that is already presenting). Try again.",
    })
    const camera = picker({ requestCamera: vi.fn(async () => { throw "no camera on this device" }) })
    expect(await pickAttachment("camera", camera, neverEncode)).toEqual({
      kind: "problem", text: "The camera did not open (no camera on this device). Try again.",
    })
  })

  it("does nothing when the person cancels or nothing comes back", async () => {
    expect(await pickAttachment("library", picker({ launch: vi.fn(async () => ({ canceled: true, assets: null })) }), neverEncode)).toEqual({ kind: "none" })
    expect(await pickAttachment("library", picker({ launch: vi.fn(async () => ({ canceled: false, assets: [] })) }), neverEncode)).toEqual({ kind: "none" })
  })

  it("states a refused image", async () => {
    const source = picker({ launch: vi.fn(async () => ({ canceled: false, assets: [{ ...asset, base64: null }] })) })
    expect(await pickAttachment("library", source, neverEncode)).toEqual({ kind: "problem", text: "IMG_0001.png could not be read." })
  })
})
