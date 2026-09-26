import type { PermissionMode, ProviderModel } from "@getdomovoi/protocol"

export type AcpProviderDefinition = Readonly<{
  id: string
  displayName: string
  commands: readonly string[]
  launchArgs: readonly string[]
  modelArgs: readonly string[]
  modes: Readonly<Record<PermissionMode, string>>
  askEnforcement: "read-only" | "unsupported"
  // Repository paths, from the session's directory up to the repository root,
  // that the agent would load and that can start programs or change its
  // permissions. A session is refused while one is present; see the daemon
  // README, "Repository configuration".
  heldBackRepositoryFiles: readonly string[]
}>

export const CURSOR_ACP_PROVIDER: AcpProviderDefinition = {
  id: "cursor-agent",
  displayName: "Cursor",
  commands: ["agent", "cursor-agent"],
  launchArgs: ["acp"],
  modelArgs: ["models"],
  askEnforcement: "read-only",
  modes: { ask: "ask", plan: "plan", build: "agent" },
  // From Cursor's CLI, MCP, hooks and third-party hooks documentation: project
  // MCP servers, hooks, CLI permission rules and sandbox policy, and the Claude
  // Code settings whose hooks Cursor runs by default. The CLI has no switch
  // that turns project configuration off.
  heldBackRepositoryFiles: [
    ".cursor/mcp.json",
    ".cursor/hooks.json",
    ".cursor/cli.json",
    ".cursor/sandbox.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
  ],
}

export const GROK_ACP_PROVIDER: AcpProviderDefinition = {
  id: "grok",
  displayName: "Grok",
  commands: ["grok"],
  launchArgs: ["agent", "stdio"],
  modelArgs: ["models"],
  askEnforcement: "unsupported",
  modes: { ask: "default", plan: "plan", build: "default" },
  // The program-starting and permission entries of Grok Build's own folder
  // trust scan (collect_repo_config_kinds in xai-grok-workspace/src/
  // folder_trust.rs at commit f0e3be1), plus its project sandbox profiles.
  // Grok loads them once the folder is trusted; GROK_FOLDER_TRUST=0 loads them
  // without asking. Project instructions, skills and personas are text.
  heldBackRepositoryFiles: [
    ".grok/config.toml",
    ".grok/hooks",
    ".grok/plugins",
    ".grok/agents",
    ".grok/roles",
    ".grok/workflows",
    ".grok/lsp.json",
    ".grok/sandbox.toml",
    ".mcp.json",
    ".cursor/mcp.json",
    ".cursor/hooks.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/agents",
    ".claude/plugins",
    ".envrc",
  ],
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
