export function terminalIdForSession(sessionId: string): string {
  const plain = `terminal-${sessionId}`
  if (plain.length <= 128) return plain
  const digest = `${fnv1a64(sessionId)}${fnv1a64(`domovoi:${sessionId}`)}`
  return `terminal-${sessionId.slice(0, 86)}-${digest}`
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, "0")
}
