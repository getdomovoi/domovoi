import type { PermissionMode, ProviderModel } from "@getdomovoi/protocol"

export type AcpProviderDefinition = Readonly<{
  id: string
  commands: readonly string[]
  launchArgs: readonly string[]
  modelArgs: readonly string[]
  modes: Readonly<Record<PermissionMode, string>>
}>

export const CURSOR_ACP_PROVIDER: AcpProviderDefinition = {
  id: "cursor-agent",
  commands: ["agent", "cursor-agent"],
  launchArgs: ["acp"],
  modelArgs: ["models"],
  modes: { ask: "ask", plan: "plan", build: "agent" },
}

export const GROK_ACP_PROVIDER: AcpProviderDefinition = {
  id: "grok",
  commands: ["grok"],
  launchArgs: ["agent", "stdio"],
  modelArgs: ["models"],
  modes: { ask: "default", plan: "plan", build: "acceptEdits" },
}

type CatalogEntry = { id?: unknown; name?: unknown; default?: unknown; isDefault?: unknown }

export function parseAcpModelCatalog(provider: string, output: string): ProviderModel[] {
  const json = parseJsonEntries(output)
  const entries = json ?? output.split(/\r?\n/).flatMap(parseTextEntry)
  const seen = new Set<string>()
  return entries.flatMap((entry) => {
    if (typeof entry.id !== "string") return []
    const id = entry.id.trim()
    if (!isModelId(id) || seen.has(id)) return []
    seen.add(id)
    return [{
      provider,
      id,
      displayName: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
      description: "",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "none",
      isDefault: entry.default === true || entry.isDefault === true,
    }]
  })
}

function parseJsonEntries(output: string): CatalogEntry[] | undefined {
  try {
    const parsed = JSON.parse(output) as unknown
    if (Array.isArray(parsed)) return parsed.filter(isObject)
    if (isObject(parsed) && Array.isArray(parsed.models)) return parsed.models.filter(isObject)
  } catch {
    // Text is the documented default for both CLIs.
  }
  return undefined
}

function parseTextEntry(line: string): CatalogEntry[] {
  const cleaned = line.trim().replace(/^[-*]\s+/, "")
  if (!cleaned || /^(available models|login required|not logged in):?$/i.test(cleaned)) return []
  const isDefault = /\s*\(default\)\s*$/i.test(cleaned)
  const id = cleaned.replace(/\s*\(default\)\s*$/i, "").split(/\s+/)[0]
  return id ? [{ id, default: isDefault }] : []
}

function isModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) && value.length <= 160
}

function isObject(value: unknown): value is CatalogEntry & { models?: unknown } {
  return typeof value === "object" && value !== null
}
