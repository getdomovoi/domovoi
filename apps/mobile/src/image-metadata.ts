// Removing what an image carries besides its pixels: where it was taken, the
// device, the time, comments, embedded previews. The bytes are a binary
// string (one character per byte, as atob returns them), so nothing here
// copies them into another buffer type.
//
// Kept: what drawing the picture needs. In a JPEG that is every segment but
// APP1 to APP15 and COM, except the ICC colour profile (APP2 ICC_PROFILE) and
// Adobe's colour transform (APP14); in a PNG every chunk but the text, EXIF
// and time chunks. Anything after the end marker goes: an iPhone appends
// secondary images there (MPF gain maps), each with its own EXIF.
//
// Undefined is a layout this does not recognise. The caller does not send
// those bytes as they are; it re-encodes them or refuses.

const pngSignature = "\x89PNG\r\n\x1a\n"
const pngMetadataChunks = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"])

function jpegSegmentIsMetadata(marker: number, segment: string): boolean {
  if (marker === 0xfe) return true
  if (marker < 0xe1 || marker > 0xef) return false
  if (marker === 0xee) return false
  if (marker === 0xe2 && segment.startsWith("ICC_PROFILE\0", 4)) return false
  return true
}

function jpegWithoutMetadata(bytes: string): string | undefined {
  let kept = "\xff\xd8"
  let at = 2
  while (at + 2 <= bytes.length) {
    if (bytes.charCodeAt(at) !== 0xff) return undefined
    const marker = bytes.charCodeAt(at + 1)
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at += 1
      continue
    }
    // Start of scan: entropy-coded data, and any later tables and scans,
    // run to the end marker. 0xFF 0xD9 cannot occur inside coded data, which
    // stuffs every 0xFF with 0x00, so the first one after the scan is the end.
    if (marker === 0xda) {
      const end = bytes.indexOf("\xff\xd9", at + 2)
      if (end < 0) return undefined
      return kept + bytes.slice(at, end + 2)
    }
    if (at + 4 > bytes.length) return undefined
    const length = (bytes.charCodeAt(at + 2) << 8) | bytes.charCodeAt(at + 3)
    if (length < 2 || at + 2 + length > bytes.length) return undefined
    const segment = bytes.slice(at, at + 2 + length)
    if (!jpegSegmentIsMetadata(marker, segment)) kept += segment
    at += 2 + length
  }
  return undefined
}

function pngWithoutMetadata(bytes: string): string | undefined {
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
    if (!pngMetadataChunks.has(type)) kept += bytes.slice(at, end)
    if (type === "IEND") return kept
    at = end
  }
  return undefined
}

export function withoutMetadata(bytes: string, mimeType: "image/png" | "image/jpeg"): string | undefined {
  if (mimeType === "image/png") return bytes.startsWith(pngSignature) ? pngWithoutMetadata(bytes) : undefined
  return bytes.startsWith("\xff\xd8") ? jpegWithoutMetadata(bytes) : undefined
}
