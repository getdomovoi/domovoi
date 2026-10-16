import { describe, expect, it } from "vitest"

import { withoutMetadata } from "./image-metadata"

const bytes = (...parts: (string | number[])[]) =>
  parts.map((part) => (typeof part === "string" ? part : String.fromCharCode(...part))).join("")
const segment = (marker: number, payload: string) => bytes([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff], payload)
const scan = bytes(segment(0xda, "\x01\x01\0\0\x3f\0"), "coded", [0xff, 0x00], "data", [0xff, 0xd9])
const frame = segment(0xc0, "\x08\0\x01\0\x01\x01\x01\x11\0")

describe("withoutMetadata on a JPEG", () => {
  it("keeps the picture's segments and drops the rest", () => {
    const camera = bytes(
      [0xff, 0xd8],
      segment(0xe0, "JFIF\0"),
      segment(0xe1, "Exif\0\0GPS"),
      segment(0xe2, "MPF\0secondary images"),
      segment(0xe2, "ICC_PROFILE\0P3"),
      segment(0xed, "Photoshop 3.0\0IPTC"),
      segment(0xee, "Adobe"),
      segment(0xfe, "comment"),
      [0xff, 0xff],
      frame,
      scan,
      // An iPhone's gain map, appended after the end marker with its own EXIF.
      bytes([0xff, 0xd8], segment(0xe1, "Exif\0\0GPS"), [0xff, 0xd9]),
    )
    expect(withoutMetadata(camera, "image/jpeg")).toBe(bytes(
      [0xff, 0xd8],
      segment(0xe0, "JFIF\0"),
      segment(0xe2, "ICC_PROFILE\0P3"),
      segment(0xee, "Adobe"),
      frame,
      scan,
    ))
  })

  // Review round 1: metadata after the first scan, as a progressive JPEG can
  // carry it, and segments no list of known metadata names.
  it("walks every scan, and keeps only segments it knows the picture needs", () => {
    const progressive = bytes(
      [0xff, 0xd8],
      segment(0xe0, "JFXX\x10thumbnail"),
      frame,
      segment(0xc4, "huffman"),
      segment(0xda, "\x01\x01\0\0\x3f\0"), "first", [0xff, 0x00], [0xff, 0xd3], "scan",
      segment(0xe1, "Exif\0\0GPS"),
      segment(0xfe, "comment"),
      segment(0xf0, "an extension"),
      segment(0xeb, "a private APP11"),
      segment(0xc4, "huffman"),
      [0xff, 0xff],
      segment(0xda, "\x01\x01\0\0\x3f\0"), "second", [0xff, 0xd9],
    )
    expect(withoutMetadata(progressive, "image/jpeg")).toBe(bytes(
      [0xff, 0xd8],
      frame,
      segment(0xc4, "huffman"),
      segment(0xda, "\x01\x01\0\0\x3f\0"), "first", [0xff, 0x00], [0xff, 0xd3], "scan",
      segment(0xc4, "huffman"),
      segment(0xda, "\x01\x01\0\0\x3f\0"), "second", [0xff, 0xd9],
    ))
    // An end marker with no scan before it is not a picture.
    expect(withoutMetadata(bytes([0xff, 0xd8], frame, [0xff, 0xd9]), "image/jpeg")).toBeUndefined()
  })

  it("returns a clean file unchanged", () => {
    const clean = bytes([0xff, 0xd8], segment(0xe0, "JFIF\0"), frame, scan)
    expect(withoutMetadata(clean, "image/jpeg")).toBe(clean)
  })

  it("does not recognise a layout it cannot walk", () => {
    expect(withoutMetadata("not a jpeg", "image/jpeg")).toBeUndefined()
    // A segment that runs past the end.
    expect(withoutMetadata(bytes([0xff, 0xd8, 0xff, 0xe1, 0x10, 0x00], "Exif"), "image/jpeg")).toBeUndefined()
    // Bytes between segments that are not a marker.
    expect(withoutMetadata(bytes([0xff, 0xd8, 0x00, 0x00]), "image/jpeg")).toBeUndefined()
    // A scan with no end marker, and a file with no scan.
    expect(withoutMetadata(bytes([0xff, 0xd8], frame, segment(0xda, "\x01"), "coded"), "image/jpeg")).toBeUndefined()
    expect(withoutMetadata(bytes([0xff, 0xd8], frame), "image/jpeg")).toBeUndefined()
    expect(withoutMetadata(bytes([0xff, 0xd8, 0xff, 0xe1, 0x00]), "image/jpeg")).toBeUndefined()
    expect(withoutMetadata(bytes([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01]), "image/jpeg")).toBeUndefined()
  })
})

const chunk = (type: string, data: string) => {
  const length = data.length
  return bytes([length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff], type, data, [0, 0, 0, 0])
}
const signature = "\x89PNG\r\n\x1a\n"

describe("withoutMetadata on a PNG", () => {
  it("drops the text, EXIF and time chunks and anything after the end", () => {
    const screenshot = bytes(
      signature,
      chunk("IHDR", "x".repeat(13)),
      chunk("iCCP", "Display P3"),
      chunk("tEXt", "Location\0GPS"),
      chunk("zTXt", "Comment\0\0z"),
      chunk("iTXt", "XML:com.adobe.xmp\0\0\0\0\0xmp"),
      chunk("eXIf", "MM\0*GPS"),
      chunk("tIME", "\x07\xea\x0a\x10\x09\x1e\0"),
      // Review round 1: a private chunk is not named by any metadata list.
      chunk("loCa", "GPS 51.5074 N"),
      chunk("iDOT", "apple"),
      chunk("pHYs", "\0\0\x0b\x13\0\0\x0b\x13\x01"),
      chunk("IDAT", "pixels"),
      chunk("IEND", ""),
      "trailing",
    )
    expect(withoutMetadata(screenshot, "image/png")).toBe(bytes(
      signature,
      chunk("IHDR", "x".repeat(13)),
      chunk("iCCP", "Display P3"),
      chunk("IDAT", "pixels"),
      chunk("IEND", ""),
    ))
  })

  it("does not recognise a layout it cannot walk", () => {
    expect(withoutMetadata("not a png", "image/png")).toBeUndefined()
    // No end chunk, and a chunk whose length runs past the end, top bit set.
    expect(withoutMetadata(bytes(signature, chunk("IHDR", "x".repeat(13))), "image/png")).toBeUndefined()
    expect(withoutMetadata(bytes(signature, [0x80, 0, 0, 0], "IDAT", [0, 0, 0, 0]), "image/png")).toBeUndefined()
  })
})
