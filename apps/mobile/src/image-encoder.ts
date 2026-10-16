import { File, Paths } from "expo-file-system"
import { ImageManipulator, SaveFormat } from "expo-image-manipulator"

import type { ImageEncoder } from "./attachments"

// Deletes a file the picker or the encoder wrote into this app's cache.
// Anything outside the cache is not this app's copy and is left alone.
export function discardCachedFile(uri: string): void {
  if (!uri.startsWith(Paths.cache.uri)) return
  const file = new File(uri)
  if (file.exists) file.delete()
}

// The device side of attachmentFrom's resize (Q121 A): expo-image-manipulator
// loads the picked file, applies its EXIF orientation, draws it at the size
// asked, and writes a new file from the pixels alone, so the camera's
// metadata is not copied. attachmentFrom still cuts any metadata segment from
// what this returns, and checks its size and type. The written file is
// deleted once its Base64 is read. A native module: adding it needed a
// rebuild of the phone app.
export const encodeImage: ImageEncoder = async ({ uri, width, height, format, quality }) => {
  const context = ImageManipulator.manipulate(uri)
  try {
    const image = await context.resize({ width, height }).renderAsync()
    try {
      const saved = await image.saveAsync({
        format: format === "png" ? SaveFormat.PNG : SaveFormat.JPEG,
        compress: quality,
        base64: true,
      })
      try {
        discardCachedFile(saved.uri)
      } catch {
        // The bytes are read; a copy that could not be removed is left to
        // the system's cache eviction.
      }
      if (!saved.base64) throw new Error("the encoder wrote no image data")
      return { base64: saved.base64, width: saved.width, height: saved.height }
    } finally {
      image.release()
    }
  } finally {
    context.release()
  }
}
