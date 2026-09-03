import { readFileSync } from "node:fs"
import { join } from "node:path"

export function readPackageScripts(directory: string): Record<string, string> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const scripts = (parsed as { scripts?: unknown }).scripts
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return undefined
  const entries = Object.entries(scripts).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}
