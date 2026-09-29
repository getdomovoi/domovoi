import { useId, useState, type ComponentType, type ReactNode } from "react"
import {
  BotIcon,
  EyeIcon,
  FileTextIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  KeyRoundIcon,
  PuzzleIcon,
  SearchXIcon,
  ServerIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalIcon,
  WebhookIcon,
} from "lucide-react"

import type { RepositoryTrustState, ToolInventory, ToolInventoryFile, ToolInventoryProvider } from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { ScrollArea } from "./components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group"
import { cn } from "./lib/utils"
import {
  fromRepository,
  incompleteReason,
  kindCounts,
  plural,
  providerRows,
  readFileCount,
  repositoryGroupNote,
  repositoryName,
  repositoryRuns,
  toolKindLabel,
  toolSourceLabel,
  trustRefusalLabel,
  trustSummary,
  unreadableFiles,
  type ToolRow,
  type ToolRowKind,
} from "./tool-inventory-model"

export type ToolInventoryLoad =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "loaded"; inventory: ToolInventory; readAt: Date }

type Unreadable = Extract<ToolInventoryFile, { state: "unreadable" }>

const kindIcon: Record<ToolRowKind, ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  "tool-server": ServerIcon,
  hook: WebhookIcon,
  "permission-rule": ShieldCheckIcon,
  "env-key": KeyRoundIcon,
  helper: TerminalIcon,
  plugin: PuzzleIcon,
  skill: SparklesIcon,
}

const readTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })

const eyebrow = "text-[10.5px] font-medium tracking-[0.13em] text-faint"
const mono = "font-machine"

// Read and report only: nothing here grants, revokes or starts anything.
export function ToolInventoryView({ inventory, onRetry }: { inventory: ToolInventoryLoad; onRetry: () => void }) {
  const [view, setView] = useState<"agent" | "file">("agent")
  const loaded = inventory.state === "loaded" ? inventory.inventory : undefined
  const repository = loaded?.repository
  const name = repository ? repositoryName(repository.root) : undefined

  return (
    <ScrollArea className="min-h-0 min-w-0 flex-1">
      <main className="mx-auto flex w-full max-w-[900px] flex-col gap-5 px-6 pt-8 pb-10">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="m-0 text-[20px] font-semibold tracking-[-0.015em]">Tools on {loaded?.machine.name ?? "this machine"}</h1>
            {repository ? <span className={cn(mono, "text-[11.5px] break-all text-muted-foreground")}>{name} · {repository.root}</span> : null}
          </div>
          <p className="m-0 text-[13px] leading-[1.65] text-muted-foreground">Domovoi reads these files and reports what they declare. It installs, enables and changes nothing.</p>
        </header>

        {inventory.state === "loading" ? (
          <div role="status" className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">Reading the agents' files on the execution machine.</div>
        ) : null}

        {inventory.state === "error" ? (
          <Alert variant="destructive">
            <FileTextIcon />
            <AlertTitle>Tools could not be read</AlertTitle>
            <AlertDescription className="flex items-center justify-between gap-3">
              <span>{inventory.message}</span>
              <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {inventory.state === "loaded" ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={view}
                aria-label="Group tools"
                onValueChange={(value) => { if (value === "agent" || value === "file") setView(value) }}
              >
                <ToggleGroupItem value="agent">By agent</ToggleGroupItem>
                <ToggleGroupItem value="file">By source file</ToggleGroupItem>
              </ToggleGroup>
              <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground"><EyeIcon className="size-4" aria-hidden />Read only</span>
              <span className="flex-1" />
              <span className={cn(mono, "text-[10.5px] text-faint")}>{readMeta(inventory.inventory, inventory.readAt)}</span>
            </div>

            {repository && name ? (
              <>
                <RepositoryRunsPanel inventory={inventory.inventory} meta={`${name} · ${trustSummary(repository.trust)}`} />
                <TrustRefusals trust={repository.trust} name={name} />
              </>
            ) : (
              <Empty className="min-h-52 border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><FolderOpenIcon /></EmptyMedia>
                  <EmptyTitle>No project is open</EmptyTitle>
                  <EmptyDescription>Open a project, and Domovoi reads the files its agents would load there.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}

            {view === "agent"
              ? inventory.inventory.providers.map((provider) => (
                  <AgentPanel key={provider.provider} provider={provider} trust={repository?.trust} />
                ))
              : <SourceFilePanels providers={inventory.inventory.providers} />}
          </>
        ) : null}
      </main>
    </ScrollArea>
  )
}

function readMeta(inventory: ToolInventory, readAt: Date): string {
  // A file two agents both read is one file.
  const files = new Map<string, ToolInventoryFile>()
  for (const provider of inventory.providers) for (const file of provider.files) files.set(file.path, file)
  const all = [...files.values()]
  const unreadable = unreadableFiles(all).length
  return `read ${readTime.format(readAt)} · ${plural(readFileCount(all), "file", "files")}${unreadable > 0 ? ` · ${unreadable} unreadable` : ""}`
}

function RepositoryRunsPanel({ inventory, meta }: { inventory: ToolInventory; meta: string }) {
  const titleId = useId()
  const summary = repositoryRuns(inventory)
  const { runs } = summary
  // A file not read or entries left out may hold more, so the list never
  // claims to be whole then.
  const incomplete = incompleteReason(summary)
  if (runs.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-dashed px-[15px] py-3 text-[12px] text-muted-foreground">
        <FolderGit2Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 basis-64">{incomplete ? `No entry listed here runs when a session starts, but the list is not complete: ${incomplete}.` : "Nothing from this repository can run when a session starts."}</span>
        <span className={cn(mono, "text-[10.5px] text-faint")}>{meta}</span>
      </div>
    )
  }
  const title = `${plural(runs.length, "entry", "entries")} from this repository ${runs.length === 1 ? "runs" : "run"} when a session starts`
  return (
    <section aria-labelledby={titleId} className="overflow-hidden rounded-xl border border-info-border bg-info-background text-info-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-[15px] py-3">
        <FolderGit2Icon className="size-4 shrink-0" aria-hidden />
        <h2 id={titleId} className="m-0 text-[13px] font-medium">{title}</h2>
        <span className="flex-1" />
        <span className={cn(mono, "text-[10.5px] text-info-dim")}>{meta}</span>
      </div>
      <ul className="m-0 list-none p-0">
        {runs.map((row) => {
          const Icon = kindIcon[row.kind]
          return (
            <li key={row.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-info-border px-[15px] py-[9px]">
              <Icon className="size-4 shrink-0 text-info-dim" aria-hidden />
              <span className="w-[84px] shrink-0 text-[11.5px]">{toolKindLabel[row.kind]}</span>
              <span className={cn(mono, "w-40 shrink-0 text-[11px] break-all")}>{row.name}</span>
              <span className={cn(mono, "min-w-0 flex-1 basis-64 text-[10.5px] break-all text-info-dim")}>{row.detail}</span>
              <span className={cn(mono, "text-[10.5px] text-info-dim")}>{row.file.path}</span>
            </li>
          )
        })}
      </ul>
      {incomplete ? <p className="m-0 border-t border-info-border px-[15px] py-[9px] text-[11.5px]">This list is not complete: {incomplete}.</p> : null}
      <p className="m-0 border-t border-info-border px-[15px] pt-[9px] pb-[11px] text-[11.5px] text-info-dim">Listed before any session opens. Reading them does not start them.</p>
    </section>
  )
}

function TrustRefusals({ trust, name }: { trust: RepositoryTrustState; name: string }) {
  const titleId = useId()
  if (trust.state !== "untrusted" || trust.reason !== "cannot-trust") return null
  return (
    <section aria-labelledby={titleId} className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2.5 px-[15px] pt-3 pb-1">
        <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
        <h2 id={titleId} className="m-0 text-[13px] font-medium">{name} cannot be trusted on this machine</h2>
      </div>
      <p className="m-0 px-[15px] pb-3 text-[12px] text-muted-foreground">Its agents would also load what is listed here, and trust cannot cover it.</p>
      <ul className="m-0 list-none p-0">
        {trust.refusals.map((refusal, index) => (
          <li key={`${refusal.provider}:${refusal.code}:${refusal.path}:${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-[15px] py-[9px]">
            <span className={cn(mono, "w-24 shrink-0 text-[11px] text-strong")}>{refusal.provider}</span>
            <span className="min-w-0 flex-1 basis-64 text-[11.5px] text-muted-foreground">{trustRefusalLabel[refusal.code]}</span>
            <span className={cn(mono, "text-[10.5px] break-all text-faint")}>{refusal.path}</span>
          </li>
        ))}
      </ul>
      {trust.omittedRefusals > 0 ? (
        <p className="m-0 border-t px-[15px] py-[9px] text-[11.5px] text-muted-foreground">{trust.omittedRefusals} more {trust.omittedRefusals === 1 ? "reason is" : "reasons are"} not listed.</p>
      ) : null}
    </section>
  )
}

function StartChip({ start }: { start: ToolRow["start"] }) {
  if (start === "runs") {
    return <Badge variant="outline" className="h-auto rounded-full border-info-border bg-info-background px-2 py-0.5 text-[10.5px] font-normal text-info-foreground">Runs when a session starts</Badge>
  }
  if (start === "held") {
    return <Badge variant="outline" className="h-auto rounded-full border-border bg-accent px-2 py-0.5 text-[10.5px] font-normal text-muted-foreground">Held back until you trust this repository</Badge>
  }
  return null
}

function EntryRow({ row, showSource }: { row: ToolRow; showSource: boolean }) {
  const Icon = kindIcon[row.kind]
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1.5 border-t px-3.5 py-[11px]">
      <Icon className="mt-px size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="w-[84px] shrink-0 text-[11.5px] leading-normal text-muted-foreground">{toolKindLabel[row.kind]}</span>
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn(mono, "text-[11.5px] break-all text-strong")}>{row.name}</span>
          <StartChip start={row.start} />
        </div>
        {row.detail ? <span className={cn(mono, "text-[10.5px] leading-normal break-all text-faint")}>{row.detail}</span> : null}
      </div>
      {showSource ? (
        <div className="ml-auto flex flex-col items-end gap-1 text-right">
          <span className="text-[11.5px] text-muted-foreground">{toolSourceLabel[row.file.source]}</span>
          <span className={cn(mono, "text-[10.5px] break-all text-faint")}>{row.file.path}</span>
        </div>
      ) : null}
    </li>
  )
}

function UnreadRow({ file }: { file: Unreadable }) {
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1.5 border-t border-danger-border bg-danger-background px-3.5 py-3">
      <span className="mt-1.5 size-[7px] shrink-0 rounded-full bg-destructive" aria-hidden />
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
        <div className="text-[12.5px] text-danger-foreground">Could not read <span className={cn(mono, "text-[11.5px] break-all")}>{file.path}</span></div>
        <div className={cn(mono, "text-[10.5px] text-danger-dim")}>{file.reason}</div>
        <div className="text-[11.5px] leading-normal text-danger-foreground">Its entries are not listed. Domovoi does not guess what the file holds.</div>
      </div>
      <span className="text-[11.5px] text-danger-dim">{toolSourceLabel[file.source]}</span>
    </li>
  )
}

function NoteRow({ text, files }: { text: string; files?: string | undefined }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3.5 py-[11px]">
      <span className="text-[11.5px] text-muted-foreground">{text}</span>
      <span className="flex-1" />
      {files ? <span className={cn(mono, "text-[10.5px] break-all text-faint")}>{files}</span> : null}
    </li>
  )
}

function GroupHeader({ label, meta }: { label: string; meta?: string | undefined }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t bg-sidebar px-3.5 py-2">
      <span className={eyebrow}>{label}</span>
      {meta ? <span className="text-[11.5px] text-faint">{meta}</span> : null}
    </div>
  )
}

function NonePassedRow() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3.5 py-[11px]">
      <span className="size-1.5 shrink-0 rounded-full bg-faint" aria-hidden />
      <span className="w-[84px] shrink-0 text-[11.5px] text-muted-foreground">Tool servers</span>
      <span className={cn(mono, "text-[11px] text-strong")}>none passed</span>
      <span className="text-[11.5px] text-muted-foreground">This agent starts with no tool servers passed.</span>
    </div>
  )
}

function notPresent(files: readonly ToolInventoryFile[]): string | undefined {
  const absent = files.filter((file) => file.state === "absent").map((file) => file.path)
  return absent.length > 0 ? `not present: ${absent.join(", ")}` : undefined
}

function omittedText(count: number): string {
  return `${count} more ${count === 1 ? "entry was" : "entries were"} left out to keep the answer within its size limit. They are not listed here.`
}

function AgentPanel({ provider, trust }: { provider: ToolInventoryProvider; trust: RepositoryTrustState | undefined }) {
  const rows = providerRows(provider)
  const unreadable = unreadableFiles(provider.files)
  const readN = readFileCount(provider.files)
  const nonePassed = provider.toolServers === "none-passed"
  const empty = rows.length === 0 && unreadable.length === 0 && provider.omittedEntries === 0
  const meta = `${unreadable.length > 0 ? `${readN} of ${plural(readN + unreadable.length, "file", "files")}` : plural(readN, "file", "files")} read · ${plural(rows.length, "entry", "entries")}${provider.omittedEntries > 0 ? ` · ${provider.omittedEntries} left out` : ""}`

  const repositoryFiles = provider.files.filter((file) => fromRepository(file.source))
  const machineFiles = provider.files.filter((file) => !fromRepository(file.source))
  const repositoryRows = rows.filter((row) => fromRepository(row.file.source))
  const machineRows = rows.filter((row) => !fromRepository(row.file.source))

  const group = (groupRows: ToolRow[], files: ToolInventoryFile[]): ReactNode => {
    const unread = unreadableFiles(files)
    if (groupRows.length === 0 && unread.length === 0) return <NoteRow text="Nothing found." files={notPresent(files)} />
    return (
      <>
        {groupRows.map((row) => <EntryRow key={row.key} row={row} showSource />)}
        {unread.map((file) => <UnreadRow key={file.path} file={file} />)}
      </>
    )
  }

  return (
    <section aria-label={provider.provider} className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-[11px]">
        <BotIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className={cn(mono, "text-[12px] font-medium")}>{provider.provider}</span>
        <span className="flex-1" />
        <span className={cn(mono, "text-[10.5px] text-faint")}>{meta}</span>
      </div>
      {nonePassed ? <NonePassedRow /> : null}
      {empty ? (
        <>
          <div className="flex flex-col items-start gap-2.5 border-t px-4 pt-6 pb-3">
            <SearchXIcon className="size-6 text-muted-foreground" aria-hidden />
            <span className="text-[13px]">No tool servers, hooks or permission rules in the files read.</span>
          </div>
          <ul className="m-0 list-none p-0">
            {provider.files.map((file) => (
              <li key={file.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-[9px]">
                <span className={cn(mono, "min-w-0 flex-1 basis-64 text-[10.5px] break-all text-strong")}>{file.path}</span>
                <span className="w-32 shrink-0 text-[11.5px] text-muted-foreground">{toolSourceLabel[file.source]}</span>
                <span className={cn(mono, "w-40 shrink-0 text-right text-[10.5px] text-faint")}>{file.state === "absent" ? "not present" : "read, nothing declared"}</span>
              </li>
            ))}
            {machineFiles.length === 0 ? <NoteRow text="User and local settings were not read." /> : null}
          </ul>
        </>
      ) : (
        <>
          {repositoryFiles.length > 0 ? (
            <>
              <GroupHeader label="FROM THIS REPOSITORY" meta={repositoryGroupNote(repositoryRows, trust)} />
              <ul className="m-0 list-none p-0">{group(repositoryRows, repositoryFiles)}</ul>
            </>
          ) : null}
          <GroupHeader label="THIS MACHINE ONLY" meta={machineFiles.length > 0 ? "User and local settings, not committed." : undefined} />
          <ul className="m-0 list-none p-0">
            {machineFiles.length > 0 ? group(machineRows, machineFiles) : <NoteRow text="User and local settings were not read." />}
            {provider.omittedEntries > 0 ? <NoteRow text={omittedText(provider.omittedEntries)} /> : null}
          </ul>
        </>
      )}
    </section>
  )
}

function SourceFilePanels({ providers }: { providers: readonly ToolInventoryProvider[] }) {
  const panels = providers.flatMap((provider) => {
    const rows = providerRows(provider)
    return provider.files
      .filter((file) => file.state !== "absent")
      .map((file) => ({ provider: provider.provider, file, rows: rows.filter((row) => row.file.path === file.path) }))
  })
  // Repository files first, each side in the reader's order.
  const ordered = [...panels.filter((panel) => fromRepository(panel.file.source)), ...panels.filter((panel) => !fromRepository(panel.file.source))]
  const repositoryRows = ordered.filter((panel) => fromRepository(panel.file.source)).flatMap((panel) => panel.rows)
  // The lead says "can run" unless the daemon holds back every row it covers.
  const repositoryLead = repositoryRows.length > 0 && repositoryRows.every((row) => row.start === "held")
    ? "Held back until you trust this repository."
    : "These can run when a session starts."
  let seenRepository = false
  let seenMachine = false

  return (
    <>
      {ordered.map((panel) => {
        const inRepository = fromRepository(panel.file.source)
        const lead = inRepository ? !seenRepository : !seenMachine
        if (inRepository) seenRepository = true
        else seenMachine = true
        const unread = panel.file.state === "unreadable"
        return (
          <div key={`${panel.provider}:${panel.file.path}`} className="flex flex-col gap-2">
            {lead ? (
              <div className="flex flex-wrap items-center gap-2.5 pt-2">
                <span className={eyebrow}>{inRepository ? "FROM THIS REPOSITORY" : "THIS MACHINE ONLY"}</span>
                <span className="text-[11.5px] text-faint">{inRepository ? repositoryLead : "User and local settings, not committed."}</span>
              </div>
            ) : null}
            <section aria-label={panel.file.path} className="overflow-hidden rounded-xl border bg-card">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-[11px]">
                <FileTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className={cn(mono, "text-[12px] font-medium break-all")}>{panel.file.path}</span>
                <span className="text-[11.5px] text-muted-foreground">{toolSourceLabel[panel.file.source]}</span>
                <span className={cn(mono, "inline-flex items-center gap-1.5 rounded-full bg-accent px-2 py-0.5 text-[10.5px] text-muted-foreground")}>
                  <BotIcon className="size-3" aria-hidden />{panel.provider}
                </span>
                <span className="flex-1" />
                <span className={cn(mono, "text-[10.5px] text-faint")}>{unread ? "not read" : plural(panel.rows.length, "entry", "entries")}</span>
              </div>
              <GroupHeader label={unread ? "UNREAD" : "DECLARES"} meta={unread ? undefined : kindCounts(panel.rows) || undefined} />
              <ul className="m-0 list-none p-0">
                {panel.file.state === "unreadable" ? <UnreadRow file={panel.file} /> : null}
                {!unread && panel.rows.length === 0 ? <NoteRow text="Nothing found." /> : null}
                {panel.rows.map((row) => <EntryRow key={row.key} row={row} showSource={false} />)}
              </ul>
            </section>
          </div>
        )
      })}
      {providers.map((provider) => <SourceFileFoot key={provider.provider} provider={provider} />)}
    </>
  )
}

// What a per-file list cannot show: tool servers not passed, files not
// present, and entries left out, which the daemon counts per agent.
function SourceFileFoot({ provider }: { provider: ToolInventoryProvider }) {
  const nonePassed = provider.toolServers === "none-passed"
  const absent = notPresent(provider.files)
  if (!nonePassed && !absent && provider.omittedEntries === 0) return null
  return (
    <div role="note" aria-label={provider.provider} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-dashed px-[15px] py-3">
      <span className="size-1.5 shrink-0 rounded-full bg-faint" aria-hidden />
      <span className={cn(mono, "text-[11px] text-strong")}>{provider.provider}</span>
      {nonePassed ? (
        <>
          <span className="text-[11.5px] text-muted-foreground">Tool servers</span>
          <span className={cn(mono, "text-[11px] text-strong")}>none passed</span>
          <span className="text-[11.5px] text-muted-foreground">This agent starts with no tool servers passed.</span>
        </>
      ) : null}
      {provider.omittedEntries > 0 ? <span className="text-[11.5px] text-muted-foreground">{omittedText(provider.omittedEntries)}</span> : null}
      <span className="flex-1" />
      {absent ? <span className={cn(mono, "text-[10.5px] break-all text-faint")}>{absent}</span> : null}
    </div>
  )
}
