import { z } from "zod"

export const clientKindSchema = z.enum(["desktop", "web", "tablet", "phone", "cli"])
export const clientIdentityIdSchema = z.string().trim().min(1).max(128)
export const machineIdSchema = z.string().regex(/^machine-[0-9a-f]{32}$/)
export const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/)
export const credentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const annotationStatusSchema = z.enum(["open", "resolved"])
export const toolKindSchema = z.enum(["command", "file-change"])
export const toolStatusSchema = z.enum(["running", "completed", "failed", "declined"])
export const forkRequestIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)

const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

export function canonicalBase64DecodedByteLength(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || !canonicalBase64Pattern.test(value)) return undefined
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  const significantIndex = value.length - padding - 1
  const trailingValue = base64Alphabet.indexOf(value[significantIndex] ?? "")
  if (trailingValue < 0 || (padding === 2 && (trailingValue & 0x0f) !== 0) || (padding === 1 && (trailingValue & 0x03) !== 0)) {
    return undefined
  }
  return (value.length / 4) * 3 - padding
}
