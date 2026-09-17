import { maximumImageUploadBytes, maximumImageUploadDimension } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { attachmentFrom, attachmentRefusalMessage, attachmentSummary, type Attachment } from "./attachments"

// A 1x1 PNG, the smallest real image, as the picker hands it back.
const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
// The first bytes of a JPEG, which is all the type check reads.
const jpegHead = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64")
// Bytes that are neither, as an HEIC would be.
const otherHead = Buffer.from("....ftypheic").toString("base64")

function picked(overrides: Partial<Parameters<typeof attachmentFrom>[0]> = {}) {
  return { fileName: "IMG_0001.png", mimeType: "image/png", width: 1, height: 1, base64: png1x1, ...overrides }
}

describe("attachmentFrom", () => {
  it("takes a bounded PNG or JPEG as the daemon will take it", () => {
    const result = attachmentFrom(picked())
    expect(result).toMatchObject({
      ok: true,
      attachment: { name: "IMG_0001.png", mimeType: "image/png", width: 1, height: 1, data: png1x1, bytes: 70 },
    })
    expect(attachmentFrom(picked({ mimeType: "image/jpeg", fileName: "a.jpg", base64: jpegHead }))).toMatchObject({
      ok: true, attachment: { mimeType: "image/jpeg" },
    })
  })

  it("reads the type off the bytes, not off the picker's label", () => {
    // A library re-encodes to JPEG and keeps the PNG's name and type.
    expect(attachmentFrom(picked({ mimeType: "image/png", fileName: "shot.png", base64: jpegHead }))).toMatchObject({
      ok: true, attachment: { mimeType: "image/jpeg" },
    })
  })

  it("refuses what the daemon would refuse, and says which bound", () => {
    expect(attachmentFrom(picked({ mimeType: "image/heic", fileName: "IMG_0002.heic", base64: otherHead }))).toEqual({
      ok: false, reason: "IMG_0002.heic is not a PNG or JPEG. Only those two are sent.",
    })
    expect(attachmentFrom(picked({ width: maximumImageUploadDimension + 1 }))).toEqual({
      ok: false, reason: `IMG_0001.png is ${maximumImageUploadDimension + 1} px wide. Up to 1.5 MB and ${maximumImageUploadDimension} px on a side; it is refused rather than resized.`,
    })
    // A PNG header followed by padding past the byte bound.
    const big = png1x1.slice(0, 12) + "A".repeat(Math.ceil((maximumImageUploadBytes + 3) / 3) * 4)
    expect(attachmentFrom(picked({ base64: big }))).toMatchObject({ ok: false })
    expect((attachmentFrom(picked({ base64: big })) as { reason: string }).reason).toMatch(/Up to 1\.5 MB/)
    expect(attachmentFrom(picked({ base64: undefined }))).toEqual({
      ok: false, reason: "IMG_0001.png could not be read.",
    })
  })
})

describe("attachmentSummary", () => {
  const one: Attachment = { name: "before.png", mimeType: "image/png", width: 800, height: 600, data: "", bytes: 1_400_000 }
  const two: Attachment = { name: "after.png", mimeType: "image/png", width: 800, height: 600, data: "", bytes: 900_000 }

  it("states the total and where it goes, and the bound the way the pairing card does", () => {
    expect(attachmentSummary([one, two], "mac-mini-m4")).toBe(
      "2.3 MB uploads to mac-mini-m4 when you send, and is not kept on this phone. Images only, up to 1.5 MB and 2048 px each. Anything larger is refused rather than resized.",
    )
  })

  it("says nothing when nothing is queued", () => {
    expect(attachmentSummary([], "mac-mini-m4")).toBeUndefined()
  })
})

describe("attachmentRefusalMessage", () => {
  it("reads the daemon's named refusal and nothing else", () => {
    expect(attachmentRefusalMessage({ data: { kind: "session-attachment-refused", reason: "image-input-unsupported" } })).toMatch(/cannot take images/)
    expect(attachmentRefusalMessage({ data: { kind: "session-attachment-refused", reason: "invalid-image" } })).toMatch(/refused an image/)
    expect(attachmentRefusalMessage({ data: { kind: "other" } })).toBeUndefined()
    expect(attachmentRefusalMessage(new Error("x"))).toBeUndefined()
  })
})
