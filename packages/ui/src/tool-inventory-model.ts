import type {
  repositoryGitConfigUnreadableReasons,
  RepositoryGitFilterScope,
  RepositoryTrustParams,
  RepositoryTrustRefusal,
  RepositoryTrustState,
  ToolInventory,
  ToolInventoryEntry,
  ToolInventoryFile,
  ToolInventoryGitFilterEntry,
  ToolInventoryProvider,
  ToolInventorySource,
} from "@getdomovoi/protocol"

// What the Tools tab derives from tool.inventory. Whether an entry runs when
// a session starts is read from that entry's own heldBack and
// startsAtSessionStart, never from the repository's trust state: trust is
// recorded before it is applied, and the daemon marks what it actually keeps
// from an agent entry by entry.

export const toolSourceLabel: Record<ToolInventorySource, string> = {
  "repository-file": "repository file",
  "project-settings": "project settings",
  "local-settings": "local settings",
  "user-settings": "user settings",
}

export function fromRepository(source: ToolInventorySource): boolean {
  return source === "repository-file" || source === "project-settings"
}

export type ToolRowKind = ToolInventoryEntry["kind"]

// runs: starts at session start and is not held back. held: the daemon keeps
// it from the agent. none: neither is said of it.
export type ToolRowStart = "runs" | "held" | "none"

export type ToolRow = {
  key: string
  provider: string
  kind: ToolRowKind
  name: string
  detail: string
  file: ToolInventoryFile
  start: ToolRowStart
}

export const toolKindLabel: Record<ToolRowKind, string> = {
  "tool-server": "Tool server",
  hook: "Hook",
  "permission-rule": "Rule",
  "env-key": "Env keys",
  helper: "Helper",
  plugin: "Plugin",
  skill: "Skill",
}

// The per-file counts, in the design's order, singular and plural.
const kindCountNames: ReadonlyArray<[ToolRowKind, string, string]> = [
  ["tool-server", "tool server", "tool servers"],
  ["hook", "hook", "hooks"],
  ["plugin", "plugin", "plugins"],
  ["env-key", "env entry", "env entries"],
  ["permission-rule", "rule", "rules"],
  ["helper", "helper", "helpers"],
  ["skill", "skill", "skills"],
]

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function entryStart(entry: ToolInventoryEntry): ToolRowStart {
  if (entry.heldBack) return "held"
  return entry.startsAtSessionStart ? "runs" : "none"
}

function entryText(entry: Exclude<ToolInventoryEntry, { kind: "env-key" }>): { name: string; detail: string } {
  switch (entry.kind) {
    case "tool-server": {
      const target = entry.command ?? entry.host
      const env = entry.envKeys.length > 0 ? ` · env keys ${entry.envKeys.join(" · ")}, values not read` : ""
      return { name: entry.name, detail: `${entry.transport}${target === undefined ? "" : ` · ${target}`}${env}` }
    }
    case "hook":
      return { name: entry.matcher === undefined ? entry.event : `${entry.event} · ${entry.matcher}`, detail: entry.command }
    case "permission-rule":
      return { name: entry.rule, detail: entry.detail }
    case "helper":
      return { name: entry.name, detail: entry.command }
    case "plugin":
    case "skill":
      return { name: entry.name, detail: "" }
  }
}

// One row per entry, except environment keys: the keys one file declares with
// the same start and hold are one row, as the design draws them. A row's start
// is uniform because it is part of the grouping key.
export function providerRows(provider: ToolInventoryProvider): ToolRow[] {
  const files = new Map(provider.files.map((file) => [file.path, file]))
  const rows: ToolRow[] = []
  const envRows = new Map<string, { row: ToolRow; keys: string[] }>()
  for (const [index, entry] of provider.entries.entries()) {
    const file = files.get(entry.file)
    // The protocol refuses an entry whose file is not listed as read.
    if (!file) continue
    const start = entryStart(entry)
    if (entry.kind === "env-key") {
      const group = `${entry.file}\u0000${start}`
      const existing = envRows.get(group)
      if (existing) {
        existing.keys.push(entry.key)
        existing.row.name = existing.keys.join(" · ")
        continue
      }
      const row: ToolRow = { key: `${provider.provider}:${index}`, provider: provider.provider, kind: "env-key", name: entry.key, detail: "key names only", file, start }
      envRows.set(group, { row, keys: [entry.key] })
      rows.push(row)
      continue
    }
    rows.push({ key: `${provider.provider}:${index}`, provider: provider.provider, kind: entry.kind, file, start, ...entryText(entry) })
  }
  return rows
}

export function kindCounts(rows: readonly ToolRow[]): string {
  return kindCountNames
    .map(([kind, one, many]) => [rows.filter((row) => row.kind === kind).length, one, many] as const)
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => plural(count, one, many))
    .join(" · ")
}

export function readFileCount(files: readonly ToolInventoryFile[]): number {
  return files.filter((file) => file.state === "read" || file.state === "empty").length
}

export function unreadableFiles(files: readonly ToolInventoryFile[]): Extract<ToolInventoryFile, { state: "unreadable" }>[] {
  return files.filter((file): file is Extract<ToolInventoryFile, { state: "unreadable" }> => file.state === "unreadable")
}

// The repository's rows that run when a session starts, and whether the list
// they come from is whole. A file that could not be read, or entries the
// daemon left out, may hold more, so "nothing runs" cannot be said then.
// omittedEntries is counted per agent, not per file, so an agent that lists
// any repository file counts all of its omissions here.
export type RepositoryRuns = {
  runs: ToolRow[]
  unreadable: number
  omitted: number
}

export function repositoryRuns(inventory: ToolInventory): RepositoryRuns {
  let unreadable = 0
  let omitted = 0
  const runs: ToolRow[] = []
  for (const provider of inventory.providers) {
    const repository = provider.files.filter((file) => fromRepository(file.source))
    if (repository.length === 0) continue
    unreadable += unreadableFiles(repository).length
    omitted += provider.omittedEntries
    runs.push(...providerRows(provider).filter((row) => fromRepository(row.file.source) && row.start === "runs"))
  }
  return { runs, unreadable, omitted }
}

// Why the repository's list may not be whole, or undefined when it is.
export function incompleteReason({ unreadable, omitted }: RepositoryRuns): string | undefined {
  const parts = [
    ...(unreadable > 0 ? [`${plural(unreadable, "file", "files")} could not be read`] : []),
    ...(omitted > 0 ? [`${omitted} ${omitted === 1 ? "entry was" : "entries were"} left out`] : []),
  ]
  return parts.length > 0 ? parts.join(" and ") : undefined
}

// "12 Sep 10:41" in local time, as the design writes it. Spelled out rather
// than read from Intl, whose en-GB month names differ between ICU versions
// ("Sep" or "Sept").
const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const twoDigits = (value: number) => String(value).padStart(2, "0")

export function formatGrantTime(value: string): string {
  const time = new Date(value)
  return `${twoDigits(time.getDate())} ${monthNames[time.getMonth()]} ${twoDigits(time.getHours())}:${twoDigits(time.getMinutes())}`
}

export function trustSummary(trust: RepositoryTrustState): string {
  if (trust.state === "trusted") return `trusted ${formatGrantTime(trust.trustedAt)} from ${trust.trustedBy.client}`
  switch (trust.reason) {
    case "not-trusted":
      return "not trusted"
    case "config-changed":
      return `trusted ${formatGrantTime(trust.trustedAt)} from ${trust.trustedBy.client} · no longer applies`
    case "cannot-trust":
      return "cannot be trusted"
  }
}

// "Until you trust this repository" holds only where trusting it is still to
// do. The daemon can hold an entry back from a trusted repository (an adapter
// that does not load that file yet) and from one that cannot be trusted, so
// there the chip says only what is true: it is held back.
export function awaitsTrust(trust: RepositoryTrustState | undefined): boolean {
  return trust?.state === "untrusted" && (trust.reason === "not-trusted" || trust.reason === "config-changed")
}

export function heldBackLabel(trust: RepositoryTrustState | undefined): string {
  return awaitsTrust(trust) ? "Held back until you trust this repository" : "Held back"
}

// Held back, said of every repository row, as a sentence.
export function allHeldBackText(trust: RepositoryTrustState | undefined): string {
  if (awaitsTrust(trust)) return "Held back until you trust this repository."
  return trust?.state === "trusted" ? "Held back, although this repository is trusted." : "Held back."
}

// The note beside a repository group. Each clause follows the rows' own
// heldBack: "held back" only for rows the daemon holds back, and "so they
// run" only when none is held back. Trust is named only as a fact beside it.
export function repositoryGroupNote(rows: readonly ToolRow[], trust: RepositoryTrustState | undefined): string {
  const lead = "Project settings and repository files."
  if (rows.length === 0) return lead
  const held = rows.filter((row) => row.start === "held").length
  if (held === rows.length) return `${lead} ${allHeldBackText(trust)}`
  if (held > 0) return `${lead} ${held} of ${rows.length} held back${awaitsTrust(trust) ? " until you trust this repository" : ""}.`
  return trust?.state === "trusted"
    ? `${lead} Trusted here, so they run when a session starts.`
    : `${lead} Not held back, so they run when a session starts.`
}

// One repository config file as trust reviews it: every agent that reads it,
// and its entries once, however many agents read the same file. A file that is
// not present holds nothing to review, though the digest still covers it.
export type RepositoryFileGroup = {
  file: ToolInventoryFile
  providers: string[]
  rows: ToolRow[]
  envKeys: number
}

export function repositoryFileGroups(inventory: ToolInventory): RepositoryFileGroup[] {
  const groups = new Map<string, RepositoryFileGroup & { seen: Set<string> }>()
  for (const provider of inventory.providers) {
    const rows = providerRows(provider)
    for (const file of provider.files) {
      if (!fromRepository(file.source) || file.state === "absent") continue
      let group = groups.get(file.path)
      if (!group) {
        group = { file, providers: [], rows: [], envKeys: 0, seen: new Set() }
        groups.set(file.path, group)
      }
      group.providers.push(provider.provider)
      for (const row of rows) {
        if (row.file.path !== file.path) continue
        const identity = JSON.stringify([row.kind, row.name, row.detail])
        if (group.seen.has(identity)) continue
        group.seen.add(identity)
        group.rows.push(row)
        if (row.kind === "env-key") group.envKeys += row.name.split(" · ").length
      }
    }
  }
  return [...groups.values()].map(({ seen: _seen, ...group }) => group)
}

// The counts a trust review gives per file, in the design's words: environment
// keys are counted one by one, since each is a name trust lets through.
const reviewCountNames: ReadonlyArray<[ToolRowKind, string, string]> = [
  ["tool-server", "tool server", "tool servers"],
  ["hook", "hook", "hooks"],
  ["plugin", "plugin", "plugins"],
  ["env-key", "env key", "env keys"],
  ["permission-rule", "rule", "rules"],
  ["helper", "helper", "helpers"],
  ["skill", "skill", "skills"],
]

export function reviewCounts(group: RepositoryFileGroup): string {
  return reviewCountNames
    .map(([kind, one, many]) => [kind === "env-key" ? group.envKeys : group.rows.filter((row) => row.kind === kind).length, one, many] as const)
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => plural(count, one, many))
    .join(" · ")
}

// How many of the repository's rows the daemon holds back, of all of them. A
// git filter's command counts as one entry, as tool.inventory lists it.
export function repositoryHeldBack(inventory: ToolInventory): { held: number; total: number } {
  const rows = inventory.providers.flatMap((provider) => providerRows(provider).filter((row) => fromRepository(row.file.source)))
  const filters = inventory.repository?.gitFilters?.entries ?? []
  return {
    held: rows.filter((row) => row.start === "held").length + filters.filter((entry) => entry.heldBack).length,
    total: rows.length + filters.length,
  }
}

// A git filter driver runs a command whenever Git checks a file out or stages
// it, for every agent, so its file is no agent's. Git reads one file in each
// scope it is included from, and the review shows it once per scope.
export const gitFilterScopeLabel: Record<RepositoryGitFilterScope, string> = {
  local: "local git config",
  worktree: "worktree git config",
  command: "command-line git config",
}

type RepositoryGitFilterRequiredState = NonNullable<ToolInventoryGitFilterEntry["required"]>

export type GitFilterDriverRow = {
  key: string
  driver: string
  // Each operation the file sets for the driver, with its redacted command:
  // "smudge sops -d · clean sops -e".
  detail: string
  // The same, one operation and command at a time, so a review can draw each
  // command as its own text and keep its whitespace (ruling Q328).
  commands: Array<{ operation: ToolInventoryGitFilterEntry["operation"]; command: string }>
  // The driver's required state, once per distinct value its commands carry.
  // Git reads one effective value per driver, so this is one state; a Git LFS
  // setting carries none.
  required: RepositoryGitFilterRequiredState[]
}

// What a driver's effective filter.<driver>.required means when its command
// fails. The review digest pins the value, so the review shows it.
export const gitFilterRequiredText: Record<RepositoryGitFilterRequiredState, string> = {
  true: "required is true: if the filter fails, the Git command fails.",
  false: "required is false: if the filter fails, Git stores or checks out the file unfiltered.",
  unset: "required is not set: if the filter fails, Git stores or checks out the file unfiltered.",
}

export type GitFilterGroup = {
  key: string
  path: string
  scope: RepositoryGitFilterScope
  drivers: GitFilterDriverRow[]
}

export function gitFilterGroups(inventory: ToolInventory): GitFilterGroup[] {
  const filters = inventory.repository?.gitFilters
  if (!filters) return []
  return filters.files.map(({ path, scope }) => {
    const drivers = new Map<string, { entries: ToolInventoryGitFilterEntry[] }>()
    for (const entry of filters.entries) {
      if (entry.file !== path || entry.scope !== scope) continue
      const driver = drivers.get(entry.driver) ?? { entries: [] }
      driver.entries.push(entry)
      drivers.set(entry.driver, driver)
    }
    return {
      key: `${scope}\u0000${path}`,
      path,
      scope,
      drivers: [...drivers.entries()].map(([driver, { entries }]) => ({
        key: `${scope}\u0000${path}\u0000${driver}`,
        driver,
        detail: entries.map((entry) => `${entry.operation} ${entry.command}`).join(" · "),
        commands: entries.map(({ operation, command }) => ({ operation, command })),
        required: entries.flatMap((entry) => entry.required === undefined ? [] : [entry.required])
          .filter((state, index, all) => all.indexOf(state) === index),
      })),
    }
  })
}

// What repository.trust says about the git filters a review showed. The
// daemon runs the filters only under a grant that acknowledges them, by the
// review digest tool.inventory gave for the block (#688), so the review sends
// it only for the block it drew: every filter listed, none left out, the
// config read and every command shown exactly as Git runs it. A block with
// nothing in it needs no acknowledgement, and an incomplete one never gets one
// (the review offers no trust then).
export function gitFiltersAcknowledgement(inventory: ToolInventory): RepositoryTrustParams["gitFilters"] {
  const filters = inventory.repository?.gitFilters
  if (!filters || filters.unreadable !== undefined || filters.omittedEntries > 0 || filters.entries.length === 0) return undefined
  if (inexactGitFilterCommands(inventory) > 0) return undefined
  return { reviewed: true, reviewDigest: filters.reviewDigest }
}

// Filter commands the inventory does not show exactly as Git runs them, by
// the daemon's flag: only it holds the configured value. Nobody can review
// such a command, so its block offers no trust (rulings Q323, Q325).
export function inexactGitFilterCommands(inventory: ToolInventory): number {
  return inventory.repository?.gitFilters?.entries.filter((entry) => entry.commandInexact === true).length ?? 0
}

// Why trust is not offered while a filter command is not shown exactly.
export function inexactGitFilterText(count: number): string {
  return count === 1
    ? "Domovoi cannot show 1 filter command exactly as Git runs it, because it hides text that could hold a secret or that it cannot show safely. Its filters stay held back, and trust is not offered until every filter command can be shown exactly."
    : `Domovoi cannot show ${count} filter commands exactly as Git runs them, because it hides text that could hold a secret or that it cannot show safely. Their filters stay held back, and trust is not offered until every filter command can be shown exactly.`
}

export function gitFilterCount(group: GitFilterGroup): string {
  return plural(group.drivers.length, "filter driver", "filter drivers")
}

// Why the repository's Git config could not be read, worded.
type RepositoryGitConfigUnreadableReason = (typeof repositoryGitConfigUnreadableReasons)[number]
export const gitConfigUnreadableText: Record<RepositoryGitConfigUnreadableReason, string> = {
  "too-large": "its filter settings are larger than Domovoi reads",
  "git-failed": "git config failed",
}

// The daemon's reader cuts a text at the first credential trigger and writes
// the rest as this marker (inventory-redaction.ts in the daemon).
export function cutAtCredential(row: ToolRow): boolean {
  return row.name.includes("[REDACTED]") || row.detail.includes("[REDACTED]")
}

const smallNumbers = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]

export function countWord(count: number): string {
  return smallNumbers[count] ?? String(count)
}

export const trustRefusalLabel: Record<RepositoryTrustRefusal["code"], string> = {
  "nested-config": "Agent configuration below the repository root",
  "main-checkout-hooks": "Hooks in this worktree's main checkout",
  "main-checkout-unknown": "This worktree's main checkout could not be found safely",
  "instructions-outside": "An instruction file outside the repository or reached through a link",
}

export function repositoryName(root: string): string {
  return root.split(/[\\/]/u).filter(Boolean).at(-1) ?? root
}
