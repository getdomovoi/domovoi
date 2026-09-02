const maximumCaptureBytes = 1_500_000
const maximumCaptureDimension = 2048

type CapturedImage = {
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality?: "good" }): CapturedImage
  toPNG(): Uint8Array
}

export type CaptureTarget = {
  capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<CapturedImage>
}

function validSize(size: { width: number; height: number }): boolean {
  return Number.isInteger(size.width) && Number.isInteger(size.height) && size.width > 0 && size.height > 0
}

function resized(image: CapturedImage, scale: number): CapturedImage {
  const size = image.getSize()
  const width = Math.max(1, Math.floor(size.width * scale))
  const height = Math.max(1, Math.floor(size.height * scale))
  if (width >= size.width && height >= size.height) throw new Error("Annotation capture cannot be reduced")
  return image.resize({ width, height, quality: "good" })
}

function validPng(bytes: Uint8Array): boolean {
  return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
}

export async function captureAnnotationPng(
  target: CaptureTarget,
  rect: { x: number; y: number; width: number; height: number },
): Promise<{ mimeType: "image/png"; width: number; height: number; data: string }> {
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)
    || rect.x < 0
    || rect.y < 0
    || rect.width < 1
    || rect.height < 1
    || rect.width > maximumCaptureDimension
    || rect.height > maximumCaptureDimension
  ) throw new Error("Invalid annotation capture bounds")
  let image = await target.capturePage(rect)
  let size = image.getSize()
  if (!validSize(size)) throw new Error("Invalid annotation capture result")
  const dimensionScale = Math.min(
    1,
    maximumCaptureDimension / size.width,
    maximumCaptureDimension / size.height,
  )
  if (dimensionScale < 1) {
    image = resized(image, dimensionScale)
    size = image.getSize()
    if (!validSize(size) || size.width > maximumCaptureDimension || size.height > maximumCaptureDimension) {
      throw new Error("Invalid annotation capture result")
    }
  }

  let png = image.toPNG()
  for (let attempt = 0; png.byteLength > maximumCaptureBytes && attempt < 12; attempt += 1) {
    size = image.getSize()
    if (size.width === 1 && size.height === 1) break
    image = resized(image, 0.5)
    size = image.getSize()
    if (!validSize(size)) throw new Error("Invalid annotation capture result")
    png = image.toPNG()
  }
  if (png.byteLength > maximumCaptureBytes) throw new Error("Annotation capture exceeds byte limit")
  if (!validPng(png)) throw new Error("Invalid annotation capture PNG")
  size = image.getSize()
  return {
    mimeType: "image/png",
    width: size.width,
    height: size.height,
    data: Buffer.from(png).toString("base64"),
  }
}
