import { describe, expect, it } from "vitest"
import type { ImageUpload } from "@getdomovoi/protocol"
import { prepareSessionAttachments } from "./session-attachments.js"

// Header fixtures exercise metadata bounds, not provider image decoding.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 2, 1, 1, 0x11, 0, 0xff, 0xd9])
const upload = (bytes: Buffer): ImageUpload => ({ mimeType: "image/jpeg", width: 2, height: 1, data: bytes.toString("base64") })

describe("turn-local image validation", () => {
  it("passes bounded JPEG bytes without inventing an annotation", () => {
    expect(prepareSessionAttachments([upload(jpeg)], { vision: true }, "sonnet")).toEqual([
      { attachmentIndex: 0, mimeType: "image/jpeg", bytes: jpeg },
    ])
    expect(prepareSessionAttachments([], undefined, "sonnet")).toEqual([])
    expect(prepareSessionAttachments(undefined, undefined, "sonnet")).toEqual([])
  })

  it.each([
    [0xff, 0xd8], [0xff, 0xd8, 0], [0xff, 0xd8, 0xff], [0xff, 0xd8, 0xff, 0xda, 0, 2],
    [0xff, 0xd8, 0xff, 0xd9, 0, 2], [0xff, 0xd8, 0xff, 0, 0, 2],
    [0xff, 0xd8, 0xff, 0xc0, 0, 1], [0xff, 0xd8, 0xff, 0xc0, 0, 8],
    [0xff, 0xd8, 0xff, 0xc0, 0, 2], [0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 0],
  ])("refuses truncated or invalid JPEG headers: %#", (...bytes) => {
    expect(() => prepareSessionAttachments([upload(Buffer.from(bytes))], { vision: true }, "sonnet")).toThrow(/bounded PNG or JPEG/)
  })

  it("enforces bounds again before decoding at the daemon boundary", () => {
    for (const entry of [{ ...upload(jpeg), data: "AB==" },
      { ...upload(jpeg), data: Buffer.alloc(1_500_001).toString("base64") },
      { ...upload(jpeg), width: 2049 }, { ...upload(jpeg), height: 0 }]) {
      expect(() => prepareSessionAttachments([entry], { vision: true }, "sonnet")).toThrow(/bounded PNG or JPEG/)
    }
    expect(() => prepareSessionAttachments([upload(jpeg), upload(jpeg), upload(jpeg)], { vision: true }, "sonnet")).toThrow(/bounded PNG or JPEG/)
    const tooWide = Buffer.from(jpeg)
    tooWide.writeUInt16BE(2049, 14)
    expect(() => prepareSessionAttachments([{ ...upload(tooWide), width: 2049 }], { vision: true }, "sonnet")).toThrow(/bounded PNG or JPEG/)
  })
})
