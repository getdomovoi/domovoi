import type {
  RepositoryTrustRefusal,
  RepositoryTrustState,
  ToolInventory,
  ToolInventoryEntry,
  ToolInventorySource,
} from "@getdomovoi/protocol"

// What the phone Tools screen draws from tool.inventory: what the open
// repository holds back, every entry grouped by the file that declared it,
// and why. The phone reads and reports; trust is granted from desktop or web
// (ruling Q67), so nothing here offers it.
//
// The desktop and web Tools tab derives the same facts in
// packages/ui/src/tool-inventory-model.ts. The phone does not depend on
// packages/ui (it is a DOM and Tailwind package), so the few rules it needs
// are kept here and held to the same wording by their tests.

const sourceLabel: Record<ToolInventorySource, string> = {
  "repository-file": "repository file",
  "project-settings": "project settings",
  "local-settings": "local settings",
  "user-settings": "user settings",
}

const kindLabel: Record<ToolInventoryEntry["kind"], string> = {
  "tool-server": "Tool server",
  hook: "Hook",
  "permission-rule": "Rule",
  "env-key": "Env keys",
  helper: "Helper",
  plugin: "Plugin",
  skill: "Skill",
}

// The per-file counts, in the design's order, singular and plural.
const kindCountNames: ReadonlyArray<[ToolInventoryEntry["kind"], string, string]> = [
  ["tool-server", "tool server", "tool servers"],
  ["hook", "hook", "hooks"],
  ["plugin", "plugin", "plugins"],
  ["env-key", "env entry", "env entries"],
  ["permission-rule", "rule", "rules"],
  ["helper", "helper", "helpers"],
  ["skill", "skill", "skills"],
]

const refusalLabel: Record<RepositoryTrustRefusal["code"], string> = {
  "nested-config": "Agent configuration below the repository root",
  "main-checkout-hooks": "Hooks in this worktree's main checkout",
  "main-checkout-unknown": "This worktree's main checkout could not be found safely",
  "instructions-outside": "An instruction file outside the repository or reached through a link",
}

export type HeldBackRow = {
  key: string
  provider: string
  kind: string
  name: string
  detail: string
}

export type HeldBackFile = {
  path: string
  source: string
  // Every agent that reads this file and holds something in it back.
  providers: string[]
  // "3 tool servers · 1 hook", by kind.
  counts: string
  rows: HeldBackRow[]
}

export type UnreadFile = { provider: string, path: string, source: string, reason: string }

export type TrustRefusalRow = { key: string, provider: string, label: string, path: string }

export type HeldBackView =
  | { kind: "no-project", machine: string }
  | {
    kind: "repository"
    machine: string
    name: string
    root: string
    heading: string
    lead: string
    // Why each listed entry is held back. Every listed entry has the same
    // reason, because it follows the repository's trust, so it is said once
    // per file rather than dropped on a narrow screen.
    reason: string
    trust: string
    // Trusting on desktop or web would lift the hold. False when the
    // repository is trusted already or cannot be trusted at all.
    awaitsTrust: boolean
    // Held-back entries as the daemon counts them, before env keys share a row.
    held: number
    files: HeldBackFile[]
    unread: UnreadFile[]
    // Why the list may not be whole, or undefined when it is.
    incomplete: string | undefined
    refusals: TrustRefusalRow[]
    omittedRefusals: number
  }

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function fromRepository(source: ToolInventorySource): boolean {
  return source === "repository-file" || source === "project-settings"
}

function entryText(entry: Exclude<ToolInventoryEntry, { kind: "env-key" }>): { name: string, detail: string } {
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

// "12 Sep 10:41" in local time, as the design writes it, spelled out rather
// than read from Intl, whose month names differ between ICU versions.
const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const twoDigits = (value: number) => String(value).padStart(2, "0")

function grantTime(value: string): string {
  const time = new Date(value)
  return `${twoDigits(time.getDate())} ${monthNames[time.getMonth()]} ${twoDigits(time.getHours())}:${twoDigits(time.getMinutes())}`
}

export function trustSummary(trust: RepositoryTrustState): string {
  if (trust.state === "trusted") return `trusted ${grantTime(trust.trustedAt)} from ${trust.trustedBy.client}`
  switch (trust.reason) {
    case "not-trusted":
      return "not trusted"
    case "config-changed":
      return `trusted ${grantTime(trust.trustedAt)} from ${trust.trustedBy.client} · no longer applies`
    case "cannot-trust":
      return "cannot be trusted"
  }
}

// "Until you trust this repository" holds only where trusting it is still to
// do. The daemon can hold an entry back from a trusted repository and from
// one that cannot be trusted, and there the reason says only that it is.
function awaitsTrust(trust: RepositoryTrustState): boolean {
  return trust.state === "untrusted" && (trust.reason === "not-trusted" || trust.reason === "config-changed")
}

function heldBackReason(trust: RepositoryTrustState): string {
  if (awaitsTrust(trust)) return "Held back until you trust this repository."
  return trust.state === "trusted" ? "Held back, although this repository is trusted." : "Held back."
}

function repositoryName(root: string): string {
  return root.split(/[\\/]/u).filter(Boolean).at(-1) ?? root
}

export function heldBackView(inventory: ToolInventory): HeldBackView {
  const machine = inventory.machine.name
  const repository = inventory.repository
  if (!repository) return { kind: "no-project", machine }

  const files = new Map<string, HeldBackFile & { kinds: ToolInventoryEntry["kind"][] }>()
  const unread: UnreadFile[] = []
  let total = 0
  let held = 0
  let unreadable = 0
  let omitted = 0

  for (const provider of inventory.providers) {
    const listed = new Map(provider.files.map((file) => [file.path, file]))
    const repositoryFiles = provider.files.filter((file) => fromRepository(file.source))
    if (repositoryFiles.length === 0) continue
    // Entries left out are counted per agent, not per file, so an agent that
    // lists any repository file counts all of its omissions here.
    omitted += provider.omittedEntries
    for (const file of repositoryFiles) {
      if (file.state !== "unreadable") continue
      unreadable += 1
      unread.push({ provider: provider.provider, path: file.path, source: sourceLabel[file.source], reason: file.reason })
    }
    // Env keys one file declares for one agent are one row with every key on it.
    const envRows = new Map<string, HeldBackRow>()
    for (const [index, entry] of provider.entries.entries()) {
      const file = listed.get(entry.file)
      // The protocol refuses an entry whose file is not listed as read.
      if (!file || !fromRepository(file.source)) continue
      total += 1
      if (!entry.heldBack) continue
      held += 1
      let group = files.get(file.path)
      if (!group) {
        group = { path: file.path, source: sourceLabel[file.source], providers: [], counts: "", rows: [], kinds: [] }
        files.set(file.path, group)
      }
      if (!group.providers.includes(provider.provider)) group.providers.push(provider.provider)
      if (entry.kind === "env-key") {
        // Every key counts in the file's summary, the ones that share a row too.
        group.kinds.push("env-key")
        const envKey = `${file.path}\u0000${provider.provider}`
        const existing = envRows.get(envKey)
        if (existing) {
          existing.name = `${existing.name} · ${entry.key}`
          continue
        }
        const row: HeldBackRow = { key: `${provider.provider}:${index}`, provider: provider.provider, kind: kindLabel["env-key"], name: entry.key, detail: "key names only" }
        envRows.set(envKey, row)
        group.rows.push(row)
        continue
      }
      group.rows.push({ key: `${provider.provider}:${index}`, provider: provider.provider, kind: kindLabel[entry.kind], ...entryText(entry) })
      group.kinds.push(entry.kind)
    }
  }

  const incompleteParts = [
    ...(unreadable > 0 ? [`${plural(unreadable, "file", "files")} could not be read`] : []),
    ...(omitted > 0 ? [`${omitted} ${omitted === 1 ? "entry was" : "entries were"} left out`] : []),
  ]
  const incomplete = incompleteParts.length > 0 ? incompleteParts.join(" and ") : undefined

  const name = repositoryName(repository.root)
  const trust = repository.trust
  // "None of it" is said only of a list known to be whole.
  const lead = held === 0
    ? total === 0 ? "Its agent files declare nothing." : "Nothing from this repository is held back."
    : held < total
      ? `${held} of ${total} entries it brings are held back.`
      : incomplete ? "None of what is listed loads for any agent." : "None of it loads for any agent."

  return {
    kind: "repository",
    machine,
    name,
    root: repository.root,
    heading: held > 0 ? `${name} is held back on ${machine}` : `${name} on ${machine}`,
    lead,
    reason: heldBackReason(trust),
    trust: trustSummary(trust),
    awaitsTrust: awaitsTrust(trust),
    held,
    files: [...files.values()].map(({ kinds, ...file }) => ({
      ...file,
      counts: kindCountNames
        .map(([kind, one, many]) => [kinds.filter((candidate) => candidate === kind).length, one, many] as const)
        .filter(([count]) => count > 0)
        .map(([count, one, many]) => plural(count, one, many))
        .join(" · "),
    })),
    unread,
    incomplete,
    refusals: trust.state === "untrusted" && trust.reason === "cannot-trust"
      ? trust.refusals.map((refusal, index) => ({
        key: `${refusal.provider}:${refusal.code}:${refusal.path}:${index}`,
        provider: refusal.provider,
        label: refusalLabel[refusal.code],
        path: refusal.path,
      }))
      : [],
    omittedRefusals: trust.state === "untrusted" && trust.reason === "cannot-trust" ? trust.omittedRefusals : 0,
  }
}
