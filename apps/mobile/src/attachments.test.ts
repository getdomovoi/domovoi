import { maximumImageUploadBytes, maximumImageUploadDimension, type ProviderModel } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import {
  attachmentFrom,
  attachmentRefusalMessage,
  attachmentSummary,
  jpegQuality,
  modelImages,
  modelImagesLine,
  resizedNote,
  type Attachment,
  type ImageEncoder,
  type ImageEncoding,
  type PickedImage,
} from "./attachments"

// A 1x1 PNG, the smallest real image, as the picker hands it back.
const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
// Bytes that are neither, as an HEIC would be.
const otherHead = Buffer.from("....ftypheic").toString("base64")

// What a camera writes beside the pixels: where the photo was taken, the
// device, a comment. None of it may leave the phone.
const location = "GPSLatitude 51.5074 N GPSLongitude 0.1278 W"

function segment(marker: number, payload: Buffer) {
  const length = payload.length + 2
  return Buffer.concat([Buffer.from([0xff, marker, length >> 8, length & 0xff]), payload])
}

// A JPEG laid out as a camera lays one out: JFIF, then the metadata segments,
// the frame header with its size, one scan of entropy-coded bytes, and the
// end marker. The scan is filler; only the layout is read.
function jpeg(width: number, height: number, scanBytes: number, metadata = true) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    ...(metadata
      ? [
        segment(0xe1, Buffer.from(`Exif\0\0${location}`, "latin1")),
        segment(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>iPhone 17 Pro</x:xmpmeta>", "latin1")),
        segment(0xfe, Buffer.from("taken on holiday", "latin1")),
        segment(0xe2, Buffer.from("ICC_PROFILE\0\x01\x01Display P3", "latin1")),
      ]
      : []),
    segment(0xc0, Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0])),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.alloc(scanBytes, 0x55),
    Buffer.from([0xff, 0xd9]),
  ]).toString("base64")
}

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)])
}

// A PNG as a screenshot is saved: the header, text chunks naming the device
// and the time, the pixels, the end.
function png(width: number, height: number, pixelBytes: number, metadata = true) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...(metadata
      ? [
        chunk("tEXt", Buffer.from(`Location\0${location}`, "latin1")),
        chunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>iPhone 17 Pro Max</x:xmpmeta>", "latin1")),
        chunk("eXIf", Buffer.from(`MM\0*${location}`, "latin1")),
        chunk("tIME", Buffer.from([0x07, 0xea, 10, 16, 9, 30, 0])),
      ]
      : []),
    chunk("IDAT", Buffer.alloc(pixelBytes, 0x55)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64")
}

const decoded = (base64: string) => Buffer.from(base64, "base64").toString("latin1")

// The device encoder, faked: it draws at the size asked and writes a file of
// the size given per format, with its own metadata on it, as a careless
// encoder could. Each request is kept so a test can read what was asked.
function encoder(sizes: { jpeg: number, png?: number }) {
  const requests: ImageEncoding[] = []
  const encode: ImageEncoder = async (request) => {
    requests.push(request)
    const base64 = request.format === "png"
      ? png(request.width, request.height, sizes.png ?? sizes.jpeg)
      : jpeg(request.width, request.height, sizes.jpeg)
    return { base64, width: request.width, height: request.height }
  }
  return { encode, requests }
}

const neverEncode: ImageEncoder = async () => {
  throw new Error("an image inside every bound and carrying no metadata is sent as picked")
}

function picked(overrides: Partial<PickedImage> = {}): PickedImage {
  return { uri: "file:///picked/IMG_0001.png", fileName: "IMG_0001.png", mimeType: "image/png", width: 1, height: 1, base64: png1x1, ...overrides }
}

describe("attachmentFrom", () => {
  it("passes a small image with nothing to remove through unchanged", async () => {
    const result = await attachmentFrom(picked(), neverEncode)
    expect(result).toEqual({
      ok: true,
      attachment: { name: "IMG_0001.png", mimeType: "image/png", width: 1, height: 1, data: png1x1, bytes: 70 },
    })
    const clean = jpeg(800, 600, 20_000, false)
    expect(await attachmentFrom(picked({ uri: "file:///picked/a.jpg", fileName: "a.jpg", mimeType: "image/jpeg", width: 800, height: 600, base64: clean }), neverEncode)).toEqual({
      ok: true,
      attachment: { name: "a.jpg", mimeType: "image/jpeg", width: 800, height: 600, data: clean, bytes: Buffer.from(clean, "base64").length },
    })
  })

  it("reads the type off the bytes, not off the picker's label", async () => {
    // The picker says the file is a PNG and its Base64 is a JPEG: the file
    // is drawn again as a PNG, and the type sent is the one the encoder's
    // bytes carry, whatever the request asked for.
    const clean = jpeg(10, 10, 100, false)
    const jpegOnly: ImageEncoder = async (request) => ({ base64: jpeg(request.width, request.height, 100, false), width: request.width, height: request.height })
    expect(await attachmentFrom(picked({ mimeType: "image/png", fileName: "shot.png", width: 10, height: 10, base64: clean }), jpegOnly)).toMatchObject({
      ok: true, attachment: { mimeType: "image/jpeg" },
    })
    // A PNG labelled a JPEG is sent as the PNG it is.
    expect(await attachmentFrom(picked({ uri: "file:///picked/a.jpg", mimeType: "image/jpeg", fileName: "a.jpg" }), neverEncode)).toMatchObject({
      ok: true, attachment: { mimeType: "image/png", data: png1x1 },
    })
  })

  // Review round 2: a colour profile is free-form (a description, a metadata
  // dictionary), and iOS's picker writes one into every Base64 it returns.
  // A picked profile is not sent; the image is drawn again, and the device
  // encoder writes the system's own profile for the colour space it drew in.
  it("draws again a small image that carries a colour profile", async () => {
    const { encode, requests } = encoder({ jpeg: 50_000 })
    const profiled = Buffer.concat([
      Buffer.from(jpeg(800, 600, 20_000, false), "base64").subarray(0, 20),
      segment(0xe2, Buffer.from("ICC_PROFILE\0\x01\x01desc taken at home", "latin1")),
      Buffer.from(jpeg(800, 600, 20_000, false), "base64").subarray(20),
    ]).toString("base64")
    const result = await attachmentFrom(picked({ uri: "file:///picked/a.jpg", mimeType: "image/jpeg", width: 800, height: 600, base64: profiled }), encode)
    expect(requests).toEqual([{ uri: "file:///picked/a.jpg", width: 800, height: 600, format: "jpeg", quality: jpegQuality }])
    expect(decoded((result as { attachment: Attachment }).attachment.data)).not.toContain("taken at home")
  })

  // Review round 2: a small screenshot is a PNG file whose Base64 iOS hands
  // back as a JPEG; it is drawn again from the file as a PNG.
  it("draws a small PNG file again as a PNG when the picker's bytes are a JPEG", async () => {
    const { encode, requests } = encoder({ jpeg: 50_000, png: 300_000 })
    const result = await attachmentFrom(picked({ uri: "file:///picked/IMG_0413.PNG", mimeType: "image/png", width: 750, height: 1334, base64: jpeg(750, 1334, 20_000, false) }), encode)
    expect(requests).toEqual([{ uri: "file:///picked/IMG_0413.PNG", width: 750, height: 1334, format: "png", quality: 1 }])
    expect(result).toMatchObject({ ok: true, attachment: { mimeType: "image/png", width: 750, height: 1334 } })
    expect((result as { attachment: Attachment }).attachment).not.toHaveProperty("resizedFrom")
  })

  it("resizes a 4032 x 3024 photo to 2048 on the long side, as a JPEG with no metadata", async () => {
    const { encode, requests } = encoder({ jpeg: 900_000 })
    const photo = jpeg(4032, 3024, 2_000, true)
    const result = await attachmentFrom(picked({ uri: "file:///picked/IMG_4120.jpg", fileName: "IMG_4120.jpg", mimeType: "image/jpeg", width: 4032, height: 3024, base64: photo }), encode)

    expect(requests).toEqual([{ uri: "file:///picked/IMG_4120.jpg", width: maximumImageUploadDimension, height: 1536, format: "jpeg", quality: jpegQuality }])
    expect(result).toMatchObject({
      ok: true,
      attachment: { name: "IMG_4120.jpg", mimeType: "image/jpeg", width: 2048, height: 1536, resizedFrom: { width: 4032, height: 3024 } },
    })
    const attachment = (result as { attachment: Attachment }).attachment
    expect(attachment.bytes).toBeLessThanOrEqual(maximumImageUploadBytes)
    expect(attachment.bytes).toBe(Buffer.from(attachment.data, "base64").length)
    const bytes = decoded(attachment.data)
    expect(bytes.startsWith("\xff\xd8")).toBe(true)
    expect(bytes.endsWith("\xff\xd9")).toBe(true)
    for (const leak of ["GPS", "Exif", "xmpmeta", "holiday"]) expect(bytes).not.toContain(leak)
    // The colour profile and the frame header are the picture, not metadata.
    expect(bytes).toContain("ICC_PROFILE")
    expect(bytes).toContain("\xff\xc0")
  })

  it("resizes a portrait photo on its height", async () => {
    const { encode, requests } = encoder({ jpeg: 900_000 })
    await attachmentFrom(picked({ uri: "file:///picked/IMG_0001.jpg", mimeType: "image/jpeg", width: 3024, height: 4032, base64: jpeg(3024, 4032, 2_000) }), encode)
    expect(requests[0]).toMatchObject({ width: 1536, height: 2048 })
  })

  it("keeps a resized screenshot a PNG when it fits, with its text chunks removed", async () => {
    const { encode, requests } = encoder({ jpeg: 400_000, png: 1_200_000 })
    const screenshot = png(1320, 2868, 3_000_000)
    const result = await attachmentFrom(picked({ fileName: "IMG_0412.PNG", width: 1320, height: 2868, base64: screenshot }), encode)

    expect(requests).toEqual([{ uri: "file:///picked/IMG_0001.png", width: 943, height: 2048, format: "png", quality: 1 }])
    expect(result).toMatchObject({
      ok: true,
      attachment: { mimeType: "image/png", width: 943, height: 2048, resizedFrom: { width: 1320, height: 2868 } },
    })
    const attachment = (result as { attachment: Attachment }).attachment
    expect(attachment.bytes).toBeLessThanOrEqual(maximumImageUploadBytes)
    const bytes = decoded(attachment.data)
    for (const leak of ["GPS", "Location", "xmpmeta", "eXIf", "tIME"]) expect(bytes).not.toContain(leak)
    expect(bytes).toContain("IHDR")
    expect(bytes).toContain("IDAT")
    expect(bytes.endsWith("IEND\0\0\0\0")).toBe(true)
  })

  // Review round 1: iOS's picker hands back the Base64 as a JPEG re-encode
  // whatever the file is, and the file at uri is the original. A screenshot
  // is a PNG file, so it is drawn again as a PNG first.
  it("reads a screenshot's format off the picked file, not the picker's Base64", async () => {
    const { encode, requests } = encoder({ jpeg: 400_000, png: 1_200_000 })
    const result = await attachmentFrom(picked({
      uri: "file:///picked/IMG_0412.PNG",
      fileName: "IMG_0412.PNG",
      mimeType: "image/png",
      width: 1320,
      height: 2868,
      base64: jpeg(1320, 2868, 2_000),
    }), encode)
    expect(requests.map((request) => request.format)).toEqual(["png"])
    expect(result).toMatchObject({ ok: true, attachment: { mimeType: "image/png", width: 943, height: 2048 } })
    // The extension alone says so too, when the picker gives no type.
    const byName = encoder({ jpeg: 400_000, png: 1_200_000 })
    await attachmentFrom(picked({ uri: "file:///picked/shot.png", mimeType: null, width: 1320, height: 2868, base64: jpeg(1320, 2868, 2_000) }), byName.encode)
    expect(byName.requests[0]?.format).toBe("png")
  })

  it("sends a resized screenshot as a JPEG when the PNG does not fit", async () => {
    const { encode, requests } = encoder({ jpeg: 500_000, png: 2_400_000 })
    const result = await attachmentFrom(picked({ width: 1320, height: 2868, base64: png(1320, 2868, 3_000_000) }), encode)

    expect(requests.map((request) => request.format)).toEqual(["png", "jpeg"])
    expect(requests[1]).toMatchObject({ width: 943, height: 2048, quality: jpegQuality })
    expect(result).toMatchObject({ ok: true, attachment: { mimeType: "image/jpeg", width: 943, height: 2048, resizedFrom: { width: 1320, height: 2868 } } })
    expect((result as { attachment: Attachment }).attachment.bytes).toBeLessThanOrEqual(maximumImageUploadBytes)
  })

  it("re-encodes an image inside the bounds that carries metadata, at its own size", async () => {
    const { encode, requests } = encoder({ jpeg: 300_000 })
    const result = await attachmentFrom(picked({ uri: "file:///picked/IMG_0001.jpg", mimeType: "image/jpeg", width: 1600, height: 1200, base64: jpeg(1600, 1200, 400_000, true) }), encode)

    expect(requests).toEqual([{ uri: "file:///picked/IMG_0001.jpg", width: 1600, height: 1200, format: "jpeg", quality: jpegQuality }])
    const attachment = (result as { attachment: Attachment }).attachment
    expect(attachment).not.toHaveProperty("resizedFrom")
    expect(decoded(attachment.data)).not.toContain("GPS")
  })

  it("refuses an image still over the byte bound after resizing, and says so", async () => {
    const { encode } = encoder({ jpeg: maximumImageUploadBytes + 100_000 })
    const result = await attachmentFrom(picked({ uri: "file:///picked/IMG_4121.jpg", fileName: "IMG_4121.jpg", mimeType: "image/jpeg", width: 4032, height: 3024, base64: jpeg(4032, 3024, 2_000) }), encode)
    expect(result).toEqual({
      ok: false,
      reason: "IMG_4121.jpg is still 1.6 MB at 2048 x 1536 after resizing on this phone. Up to 1.5 MB and 2048 px on a side.",
    })
  })

  it("refuses an image the phone could not resize", async () => {
    const failing: ImageEncoder = async () => {
      throw new Error("Could not load the image")
    }
    expect(await attachmentFrom(picked({ width: 4032, height: 3024, base64: jpeg(4032, 3024, 2_000) }), failing)).toEqual({
      ok: false,
      reason: "IMG_0001.png could not be resized on this phone (Could not load the image). Up to 1.5 MB and 2048 px on a side.",
    })
    expect(await attachmentFrom(picked({ uri: undefined, width: 4032, height: 3024, base64: jpeg(4032, 3024, 2_000) }), failing)).toEqual({
      ok: false,
      reason: "IMG_0001.png could not be resized on this phone (no file to read). Up to 1.5 MB and 2048 px on a side.",
    })
  })

  it("checks what the encoder hands back before sending it", async () => {
    const photo = picked({ uri: "file:///picked/IMG_0001.jpg", mimeType: "image/jpeg", width: 4032, height: 3024, base64: jpeg(4032, 3024, 2_000) })
    const unresized: ImageEncoder = async () => ({ base64: jpeg(4032, 3024, 100), width: 4032, height: 3024 })
    expect(await attachmentFrom(photo, unresized)).toEqual({
      ok: false,
      reason: "IMG_0001.png could not be resized on this phone (it came back 4032 x 3024). Up to 1.5 MB and 2048 px on a side.",
    })
    const garbled: ImageEncoder = async () => ({ base64: otherHead, width: 2048, height: 1536 })
    expect(await attachmentFrom(photo, garbled)).toMatchObject({ ok: false, reason: expect.stringContaining("(it came back unreadable)") })
    const truncated: ImageEncoder = async () => ({ base64: Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x10]).toString("base64"), width: 2048, height: 1536 })
    expect(await attachmentFrom(photo, truncated)).toMatchObject({ ok: false, reason: expect.stringContaining("(it came back unreadable)") })
  })

  it("says re-encoding, not resizing, for an image the phone did not draw smaller", async () => {
    const { encode } = encoder({ jpeg: maximumImageUploadBytes + 100_000 })
    // Inside the dimension bound, over the byte bound.
    const heavy = jpeg(2000, 2000, maximumImageUploadBytes + 10_000, false)
    expect(await attachmentFrom(picked({ uri: "file:///picked/IMG_0001.jpg", mimeType: "image/jpeg", width: 2000, height: 2000, base64: heavy }), encode)).toEqual({
      ok: false,
      reason: "IMG_0001.png is still 1.6 MB at 2000 x 2000 after re-encoding on this phone. Up to 1.5 MB and 2048 px on a side.",
    })
  })

  it("refuses what the daemon would refuse and no resize could fix", async () => {
    expect(await attachmentFrom(picked({ mimeType: "image/heic", fileName: "IMG_0002.heic", base64: otherHead }), neverEncode)).toEqual({
      ok: false, reason: "IMG_0002.heic is not a PNG or JPEG. Only those two are sent.",
    })
    expect(await attachmentFrom(picked({ base64: undefined }), neverEncode)).toEqual({
      ok: false, reason: "IMG_0001.png could not be read.",
    })
  })
})

describe("resizedNote", () => {
  it("names the size the picker handed back, and nothing for an image sent as picked", () => {
    const base: Attachment = { name: "IMG_4120.jpg", mimeType: "image/jpeg", width: 2048, height: 1536, data: "", bytes: 900_000 }
    expect(resizedNote({ ...base, resizedFrom: { width: 4032, height: 3024 } })).toBe("resized from 4032 x 3024")
    expect(resizedNote(base)).toBeUndefined()
  })
})

describe("attachmentSummary", () => {
  const one: Attachment = { name: "before.png", mimeType: "image/png", width: 800, height: 600, data: "", bytes: 1_400_000 }
  const two: Attachment = { name: "after.png", mimeType: "image/png", width: 800, height: 600, data: "", bytes: 900_000 }

  it("states the total and where it goes, and the bound the way the pairing card does", () => {
    expect(attachmentSummary([one, two], "mac-mini-m4")).toBe(
      "2.3 MB uploads to mac-mini-m4 when you send, and is not kept on this phone. Images only, up to 1.5 MB and 2048 px each: "
        + "a larger one is resized on this phone first, and location and other metadata are removed.",
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

// Phone v2 frames 13 and 13b: the session's model, and whether its harness
// reports image input, read from runtime.models. Absent from the answer, or
// not yet read, is not known, which is not the same as no.
describe("modelImages", () => {
  const model = (id: string, imageInput?: boolean): ProviderModel => ({
    provider: "kilo", id, displayName: id, description: "", supportedReasoningEfforts: [], isDefault: false,
    ...(imageInput === undefined ? {} : { imageInput }),
  })
  const runtime = { provider: "kilo", model: "qwen3-coder-72b" }

  it("reads the session's own model", () => {
    expect(modelImages([model("other", true), model("qwen3-coder-72b", false)], runtime)).toEqual({ model: "qwen3-coder-72b", imageInput: false })
    expect(modelImages([model("qwen3-coder-72b", true)], runtime)).toEqual({ model: "qwen3-coder-72b", imageInput: true })
  })

  it("does not know when the model is unread, missing or silent", () => {
    expect(modelImages(undefined, runtime)).toEqual({ model: "qwen3-coder-72b", imageInput: undefined })
    expect(modelImages([model("other", false)], runtime)).toEqual({ model: "qwen3-coder-72b", imageInput: undefined })
    expect(modelImages([model("qwen3-coder-72b")], runtime)).toEqual({ model: "qwen3-coder-72b", imageInput: undefined })
    expect(modelImages([{ ...model("qwen3-coder-72b", false), provider: "codex" }], runtime).imageInput).toBeUndefined()
  })

  it("says what the harness reports, in frame 13's words", () => {
    expect(modelImagesLine(true)).toBe("takes image input, as its harness reports")
    expect(modelImagesLine(false)).toBe("takes no image input, as its harness reports")
    expect(modelImagesLine(undefined)).toBe("image input not known")
  })
})
