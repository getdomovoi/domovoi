// Removing what an image carries besides its pixels: where it was taken, the
// device, the time, comments, embedded previews. The bytes are a binary
// string (one character per byte, as atob returns them), so nothing here
// copies them into another buffer type.
//
// Both formats are cut to an allowlist of what drawing the picture needs, so
// a private or unknown segment or chunk goes too. In a JPEG: the frame,
// Huffman, arithmetic-coding, quantisation, restart and line-count segments,
// the scans, JFIF (APP0) without its thumbnail, the ICC colour profile (APP2
// ICC_PROFILE, see MetadataCut) and
// Adobe's colour transform (APP14). In a PNG: the critical chunks, colour
// and transparency chunks, and nothing else. Anything after the end marker
// goes: an iPhone appends secondary images there (MPF gain maps), each with
// its own EXIF.
//
// Undefined is a layout this does not recognise. The caller does not send
// those bytes as they are; it re-encodes them or refuses.

const pngSignature = "\x89PNG\r\n\x1a\n"
// Each kept chunk and the data lengths it may have. A fixed-size chunk with
// bytes appended carries payload a decoder rejects or skips, so it goes.
// PLTE, tRNS, iCCP and IDAT are bounded by the picture itself.
const any = () => true
const pngKeptChunks = new Map<string, (length: number) => boolean>([
  ["IHDR", (length) => length === 13],
  ["PLTE", any],
  ["IDAT", any],
  ["IEND", (length) => length === 0],
  ["tRNS", any],
  ["iCCP", any],
  ["gAMA", (length) => length === 4],
  ["cHRM", (length) => length === 32],
  ["sRGB", (length) => length === 1],
  ["sBIT", (length) => length >= 1 && length <= 4],
  ["cICP", (length) => length === 4],
  ["mDCV", (length) => length === 24],
  ["mDCv", (length) => length === 24],
  ["cLLI", (length) => length === 8],
  ["cLLi", (length) => length === 8],
])

// Colour profiles are kept by default: the cut is applied to what the
// device encoder wrote, whose profile is the system's own for the colour
// space it drew in. A profile picked from elsewhere is free-form (a
// description, a metadata dictionary, a PNG profile name), so the check
// whether a picked image may be sent as it is drops them, and an image that
// has one is drawn again rather than sent.
export type MetadataCut = { profiles: "keep" | "drop" }

// A JFIF header without its thumbnail: identifier, version, units and
// density (fourteen bytes), then a thumbnail size of zero by zero.
function jfifWithoutThumbnail(segment: string): string | undefined {
  if (!segment.startsWith("JFIF\0", 4) || segment.length < 4 + 14) return undefined
  return `\xff\xe0\0\x10${segment.slice(4, 4 + 12)}\0\0`
}

function jpegSegmentKept(marker: number, segment: string, cut: MetadataCut): string | undefined {
  // SOF0 to SOF15, DHT (C4), JPG (C8) and DAC (CC) share this range; all
  // describe the coding.
  if (marker >= 0xc0 && marker <= 0xcf) return segment
  // DQT, DRI, DNL.
  if (marker === 0xdb || marker === 0xdd || marker === 0xdc) return segment
  if (marker === 0xe0) return jfifWithoutThumbnail(segment)
  if (marker === 0xe2) return cut.profiles === "keep" && segment.startsWith("ICC_PROFILE\0", 4) ? segment : undefined
  // Adobe: identifier, version, two flag words and the colour transform,
  // twelve bytes. Anything after them is payload a decoder skips.
  if (marker === 0xee) return segment.startsWith("Adobe", 4) && segment.length >= 4 + 12 ? `\xff\xee\0\x0e${segment.slice(4, 16)}` : undefined
  return undefined
}

// The next marker after entropy-coded data starting at `from`: coded data
// stuffs every 0xFF it holds with 0x00, and restart markers (D0 to D7) sit
// inside it, so the first 0xFF followed by anything else is a marker.
function nextMarker(bytes: string, from: number): number {
  let at = bytes.indexOf("\xff", from)
  while (at >= 0 && at + 1 < bytes.length) {
    const next = bytes.charCodeAt(at + 1)
    if (next !== 0x00 && next !== 0xff && (next < 0xd0 || next > 0xd7)) return at
    at = bytes.indexOf("\xff", at + 1)
  }
  return -1
}

function jpegWithoutMetadata(bytes: string, cut: MetadataCut): string | undefined {
  let kept = "\xff\xd8"
  let at = 2
  let scanned = false
  while (at + 2 <= bytes.length) {
    if (bytes.charCodeAt(at) !== 0xff) return undefined
    const marker = bytes.charCodeAt(at + 1)
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0xd9) return scanned ? `${kept}\xff\xd9` : undefined
    if (at + 4 > bytes.length) return undefined
    const length = (bytes.charCodeAt(at + 2) << 8) | bytes.charCodeAt(at + 3)
    if (length < 2 || at + 2 + length > bytes.length) return undefined
    const segment = bytes.slice(at, at + 2 + length)
    if (marker === 0xda) {
      // A scan: its header, then coded data up to the next marker, which
      // may be another table, another scan, or a segment to drop.
      const end = nextMarker(bytes, at + 2 + length)
      if (end < 0) return undefined
      kept += bytes.slice(at, end)
      scanned = true
      at = end
      continue
    }
    kept += jpegSegmentKept(marker, segment, cut) ?? ""
    at += 2 + length
  }
  return undefined
}

function pngWithoutMetadata(bytes: string, cut: MetadataCut): string | undefined {
  let kept = pngSignature
  let at = pngSignature.length
  while (at + 12 <= bytes.length) {
    // Multiplied rather than shifted: a length with the top bit set would turn
    // negative under <<.
    const length = bytes.charCodeAt(at) * 0x1000000
      + ((bytes.charCodeAt(at + 1) << 16) | (bytes.charCodeAt(at + 2) << 8) | bytes.charCodeAt(at + 3))
    const end = at + 12 + length
    if (end > bytes.length) return undefined
    const type = bytes.slice(at + 4, at + 8)
    const sized = pngKeptChunks.get(type)?.(length) ?? false
    // A header or end of the wrong size is not a picture this recognises.
    if ((type === "IHDR" || type === "IEND") && !sized) return undefined
    if (sized && (type !== "iCCP" || cut.profiles === "keep")) kept += bytes.slice(at, end)
    if (type === "IEND") return kept
    at = end
  }
  return undefined
}

export function withoutMetadata(
  bytes: string,
  mimeType: "image/png" | "image/jpeg",
  cut: MetadataCut = { profiles: "keep" },
): string | undefined {
  if (mimeType === "image/png") return bytes.startsWith(pngSignature) ? pngWithoutMetadata(bytes, cut) : undefined
  return bytes.startsWith("\xff\xd8") ? jpegWithoutMetadata(bytes, cut) : undefined
}
