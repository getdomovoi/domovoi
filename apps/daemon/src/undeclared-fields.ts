export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// A non-strict schema strips a field it does not know rather than refusing it.
// Every own field of what was sent that the parsed value lacks is returned, at
// any depth, so the caller can refuse it.
export function undeclaredFields(sent: unknown, parsed: unknown, path: string): string[] {
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
