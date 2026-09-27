import type { PermissionMode, ProviderModel } from "@getdomovoi/protocol"

export type AcpProviderDefinition = Readonly<{
  id: string
  commands: readonly string[]
  launchArgs: readonly string[]
  modelArgs: readonly string[]
  modes: Readonly<Record<PermissionMode, string>>
  askEnforcement: "read-only" | "unsupported"
}>

export const CURSOR_ACP_PROVIDER: AcpProviderDefinition = {
  id: "cursor-agent",
  commands: ["agent", "cursor-agent"],
  launchArgs: ["acp"],
  modelArgs: ["models"],
  askEnforcement: "read-only",
  modes: { ask: "ask", plan: "plan", build: "agent" },
}

export const GROK_ACP_PROVIDER: AcpProviderDefinition = {
  id: "grok",
  commands: ["grok"],
  launchArgs: ["agent", "stdio"],
  modelArgs: ["models"],
  askEnforcement: "unsupported",
  modes: { ask: "default", plan: "plan", build: "default" },
}

// Cursor and Grok load MCP servers, hooks and permission rules from the
// repository they work in, and neither can be told not to. Until the trust
// gate ships the daemon does not run them for any reason: provider discovery
// reports them unable to start, no adapter is registered, and a stored session
// is refused. Owner ruling Q40 A, 2026-09-26. Set this to false to turn them
// back on; the definitions above are kept for that.
export const acpProvidersTurnedOff = true

export const acpProviderNames: Readonly<Record<string, string>> = {
  [CURSOR_ACP_PROVIDER.id]: "Cursor",
  [GROK_ACP_PROVIDER.id]: "Grok",
}

function repositoryConfiguration(name: string): string {
  return `${name} loads MCP servers, hooks and permission rules from the repository it works in, `
    + "and Domovoi does not load repository-brought configuration until a trust gate ships."
}

export function acpProviderTurnedOffReason(name: string): string {
  return `${name} is turned off in Domovoi for now. ${repositoryConfiguration(name)}`
}

export function acpProviderTurnedOffResumeRefusal(name: string): string {
  return `This session uses ${name}, which is turned off in Domovoi for now. ${repositoryConfiguration(name)} `
    + "The worktree and conversation are kept."
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
  if (!cleaned) return []
  const defaultMarker = /\s+\((?:default|current)\)\s*$/i
  const isDefault = defaultMarker.test(cleaned)
  const entry = cleaned.replace(defaultMarker, "")
  const separator = entry.indexOf(" - ")
  const id = (separator === -1 ? entry : entry.slice(0, separator)).trim()
  if (!id || /\s/.test(id) || isBannerToken(id)) return []
  return [{ id, default: isDefault }]
}

function isBannerToken(value: string): boolean {
  return /^(?:available|authentication|filter|login|models?|not|tip|workspace):?$/i.test(value)
}

function isModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) && value.length <= 160
}

function isObject(value: unknown): value is CatalogEntry & { models?: unknown } {
  return typeof value === "object" && value !== null
}
