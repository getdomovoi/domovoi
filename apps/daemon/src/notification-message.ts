import { notificationMethods, type NotificationMethod, type NotificationParams } from "@getdomovoi/protocol"

export type NotificationFrame = { readonly method: NotificationMethod, readonly text: string }

const issuedFrames = new WeakSet<NotificationFrame>()

// True only for a frame notificationMessage built. The RPC writer sends no
// other notification.
export function isNotificationFrame(value: unknown): value is NotificationFrame {
  return typeof value === "object" && value !== null && issuedFrames.has(value as NotificationFrame)
}

// The wire record fingerprints the notification schemas, so a notification
// carries only what its schema describes. A non-strict schema strips a field it
// does not know rather than refusing it; the stripped field is refused here.
// The text is serialized once and read back, and the check runs on what was
// read back: toJSON can make the text differ from the object passed in.
// The method must be a primitive string naming an own entry of
// notificationMethods: an object method could pass the lookup through toString
// and serialize as another name through toJSON.
export function notificationMessage<M extends NotificationMethod>(method: M, params: NotificationParams<M>): NotificationFrame {
  const methodValue: unknown = method
  if (typeof methodValue !== "string" || !Object.hasOwn(notificationMethods, methodValue)) {
    throw new TypeError("A notification method must be a string naming a protocol notification.")
  }
  const text = JSON.stringify({ jsonrpc: "2.0", method, params })
  const envelope: unknown = JSON.parse(text)
  if (!isRecord(envelope) || envelope.method !== method) {
    throw new TypeError(`The serialized notification method does not match ${method}.`)
  }
  const sent = envelope.params
  const parsed: unknown = notificationMethods[method].parse(sent)
  const undeclared = undeclaredFields(sent, parsed, "")
  if (undeclared.length > 0) {
    throw new Error(`${method} carries fields its protocol schema does not describe: ${undeclared.join(", ")}`)
  }
  const frame = Object.freeze({ method, text })
  issuedFrames.add(frame)
  return frame
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function undeclaredFields(sent: unknown, parsed: unknown, path: string): string[] {
  if (Array.isArray(sent) && Array.isArray(parsed)) {
    return sent.flatMap((item, index) => undeclaredFields(item, parsed[index], `${path}[${index}]`))
  }
  if (!isRecord(sent) || !isRecord(parsed)) return []
  return Object.entries(sent).flatMap(([key, value]) => {
    const at = path === "" ? key : `${path}.${key}`
    if (value === undefined) return []
    return Object.hasOwn(parsed, key) ? undeclaredFields(value, parsed[key], at) : [at]
  })
}
