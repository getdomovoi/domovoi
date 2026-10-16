import { ImageManipulator, SaveFormat } from "expo-image-manipulator"

import type { ImageEncoder } from "./attachments"

// The device side of attachmentFrom's resize (Q121 A): expo-image-manipulator
// loads the picked file, applies its EXIF orientation, draws it at the size
// asked, and writes a new file from the pixels alone, so the camera's
// metadata is not copied. attachmentFrom still cuts any metadata segment from
// what this returns, and checks its size and type. A native module: adding
// it needed a rebuild of the phone app.
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
      if (!saved.base64) throw new Error("the encoder wrote no image data")
      return { base64: saved.base64, width: saved.width, height: saved.height }
    } finally {
      image.release()
    }
  } finally {
    context.release()
  }
}
