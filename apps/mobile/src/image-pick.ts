import { attachmentFrom, type Attachment, type ImageEncoder, type PickedImage } from "./attachments"

export type ImageSource = "library" | "camera"

// The picker, narrowed to what a pick needs, so the sequence is tested
// without the native module. app.tsx builds it from expo-image-picker.
export type ImageSourcePicker = {
  requestCamera: () => Promise<{ granted: boolean }>
  launch: (source: ImageSource) => Promise<{ canceled: boolean, assets?: readonly PickedImage[] | null | undefined }>
}

export type PickOutcome =
  | { kind: "added", attachment: Attachment }
  | { kind: "problem", text: string }
  | { kind: "none" }

const opening: Record<ImageSource, string> = { library: "The photo library", camera: "The camera" }
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/\.+$/, "")

// One pick from either source. Take a photo asks for the camera first, as
// iOS requires; the photo library needs no prompt on iOS 14 and later, where
// the system picker runs outside the app. A picker that fails to open is
// stated (walk F23: it used to say nothing), and every image goes through
// attachmentFrom, so a photo and a library pick are resized the same way.
export async function pickAttachment(source: ImageSource, picker: ImageSourcePicker, encode: ImageEncoder): Promise<PickOutcome> {
  let result: Awaited<ReturnType<ImageSourcePicker["launch"]>>
  try {
    if (source === "camera") {
      const permission = await picker.requestCamera()
      if (!permission.granted) return { kind: "problem", text: "This phone has not allowed Domovoi to use the camera." }
    }
    result = await picker.launch(source)
  } catch (cause) {
    return { kind: "problem", text: `${opening[source]} did not open (${messageOf(cause)}). Try again.` }
  }
  const asset = result.canceled ? undefined : result.assets?.[0]
  if (!asset) return { kind: "none" }
  const read = await attachmentFrom(asset, encode)
  return read.ok ? { kind: "added", attachment: read.attachment } : { kind: "problem", text: read.reason }
}
