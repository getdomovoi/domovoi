import { notificationMethods, type NotificationMethod, type NotificationParams } from "@getdomovoi/protocol"

// The wire record fingerprints the notification schemas, so a notification
// carries only what its schema describes. A non-strict schema strips a field it
// does not know rather than refusing it; the stripped field is refused here.
export function notificationMessage<M extends NotificationMethod>(method: M, params: NotificationParams<M>): string {
  const parsed: unknown = notificationMethods[method].parse(params)
  const undeclared = undeclaredFields(params, parsed, "")
  if (undeclared.length > 0) {
    throw new Error(`${method} carries fields its protocol schema does not describe: ${undeclared.join(", ")}`)
  }
  return JSON.stringify({ jsonrpc: "2.0", method, params })
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
    return key in parsed ? undeclaredFields(value, parsed[key], at) : [at]
  })
}
