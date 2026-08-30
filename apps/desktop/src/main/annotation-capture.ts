const maximumCaptureBytes = 1_500_000
const maximumCaptureDimension = 2048

type CaptureTarget = {
  capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<{
    getSize(): { width: number; height: number }
    toPNG(): Uint8Array
  }>
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
  const image = await target.capturePage(rect)
  const size = image.getSize()
  if (size.width < 1 || size.height < 1 || size.width > maximumCaptureDimension || size.height > maximumCaptureDimension) {
    throw new Error("Invalid annotation capture result")
  }
  const png = image.toPNG()
  if (png.byteLength < 8 || png.byteLength > maximumCaptureBytes) {
    throw new Error("Annotation capture exceeds byte limit")
  }
  return {
    mimeType: "image/png",
    width: size.width,
    height: size.height,
    data: Buffer.from(png).toString("base64"),
  }
}
