import { useState } from "react"
import { BotIcon, FileTextIcon, FilterIcon } from "lucide-react"

import type { RepositoryTrust, RepositoryTrustParams, RepositoryTrustResult, RepositoryTrustState } from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog"
import { cn } from "./lib/utils"
import {
  countWord,
  cutAtCredential,
  gitConfigUnreadableText,
  gitFilterCount,
  gitFilterGroups,
  gitFilterRequiredText,
  gitFilterScopeLabel,
  gitFiltersAcknowledgement,
  hiddenGitFilterCommands,
  hiddenGitFilterText,
  repositoryFileGroups,
  repositoryHeldBack,
  repositoryName,
  reviewCounts,
  toolKindLabel,
  toolSourceLabel,
  type GitFilterGroup,
  type RepositoryFileGroup,
} from "./tool-inventory-model"
import { eyebrow, GrantedWhere, kindIcon, mono, omittedText, TrustRefusals } from "./tool-inventory-parts"
import type { ToolInventoryLoad } from "./tool-inventory-view"

// gitFilters is present only when the sheet showed every git filter the
// repository's own Git config sets (gitFiltersAcknowledgement).
export type RepositoryTrustRequestParams = Omit<RepositoryTrustParams, "client">
export type RepositoryTrustRequest = (params: RepositoryTrustRequestParams) => Promise<RepositoryTrustResult>

// What the last trust request came back with, until the person acts again.
type Outcome =
  | { kind: "changed" }
  | { kind: "cannot-trust"; trust: RepositoryTrustState }
  | { kind: "failed"; message: string }

// The one review surface for trust (design step 13), desktop and web only.
// It shows what the inventory the Tools tab holds says, and trust sends that
// inventory's configuration digest: the one the person is looking at. When the
// daemon answers that the configuration changed, nothing was trusted; the
// sheet says so and the tab reads the files again, and trusting what they hold
// now is the person's next decision, never a retry made for them.
//
// onTrusted hears of a grant, for a surface that opened the sheet to act on
// it (a refused session): the repository as the daemon now records it.
export function RepositoryTrustSheet({
  open,
  onOpenChange,
  inventory,
  onTrust,
  onReload,
  onTrusted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  inventory: ToolInventoryLoad
  onTrust: RepositoryTrustRequest
  onReload: () => void
  onTrusted?: ((repository: RepositoryTrust) => void) | undefined
}) {
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined)
  const loaded = inventory.state === "loaded" ? inventory.inventory : undefined
  const repository = loaded?.repository
  const name = repository ? repositoryName(repository.root) : "this repository"
  const machine = loaded?.machine.name ?? "this machine"
  // A trusted repository is reviewed again when its git filters are held back
  // under a grant that did not acknowledge them, or acknowledged others.
  const again = repository?.trust.state === "trusted" || (repository?.trust.state === "untrusted" && repository.trust.reason === "config-changed")
  const refused = outcome?.kind === "cannot-trust"
    ? outcome.trust
    : repository?.trust.state === "untrusted" && repository.trust.reason === "cannot-trust" ? repository.trust : undefined
  const groups = loaded ? repositoryFileGroups(loaded) : []
  const gitGroups = loaded ? gitFilterGroups(loaded) : []
  const gitFilters = repository?.gitFilters
  // "None of it has run" holds only when the daemon holds back every entry
  // the repository brings; an agent whose files it does not hold back loads
  // them already.
  const held = loaded ? repositoryHeldBack(loaded) : { held: 0, total: 0 }
  const omitted = loaded?.providers.filter((provider) => provider.omittedEntries > 0 && provider.files.some((file) => groups.some((group) => group.file.path === file.path))) ?? []
  // Entries the daemon left out to fit its answer, and files it could not
  // read, are still covered by the digest, so a grant would approve what
  // nobody saw: no trust is offered until every entry can be listed and every
  // file read (ruling Q219 A). The repository's Git config is one of them.
  const gitOmitted = gitFilters?.omittedEntries ?? 0
  const notShown = omitted.reduce((total, provider) => total + provider.omittedEntries, 0) + gitOmitted
  const unreadable = groups.filter((group) => group.file.state === "unreadable").map((group) => group.file.path)
  const gitUnreadable = gitFilters?.unreadable
  // A filter command redaction hid part of shows the person less than runs,
  // so it blocks trust the same way (ruling Q323), credential-only cuts
  // included: the inventory does not say what was hidden.
  const hiddenCommands = loaded ? hiddenGitFilterCommands(loaded) : 0
  const incomplete = notShown > 0 || unreadable.length > 0 || gitUnreadable !== undefined || hiddenCommands > 0
  const offerTrust = repository !== undefined && refused === undefined && inventory.state === "loaded" && !incomplete
  const canTrust = offerTrust && !pending

  // What the sheet shows is pinned by the configuration digest and the git
  // filter block's review digest. When a read made while it is open shows
  // other ones, the person is told before anything is trusted: trust always
  // sends the digests drawn now, never ones from an earlier read.
  const shownKey = open && repository ? `${repository.configDigest}\u0000${repository.gitFilters?.reviewDigest ?? ""}` : undefined
  const [shown, setShown] = useState<string | undefined>(undefined)
  // Adjusted during render rather than in an effect, so the notice and the
  // new digests are drawn together.
  if (!open && shown !== undefined) setShown(undefined)
  if (shownKey !== undefined && shownKey !== shown) {
    if (shown !== undefined) setOutcome({ kind: "changed" })
    setShown(shownKey)
  }

  const change = (next: boolean) => {
    if (!next) setOutcome(undefined)
    onOpenChange(next)
  }

  const trust = async () => {
    if (!repository || !loaded) return
    setPending(true)
    setOutcome(undefined)
    const gitFilters = gitFiltersAcknowledgement(loaded)
    try {
      const result = await onTrust({
        projectId: repository.projectId,
        configDigest: repository.configDigest,
        ...(gitFilters ? { gitFilters } : {}),
      })
      if (result.outcome === "trusted") {
        change(false)
        onTrusted?.(result.repository)
      } else if (result.outcome === "config-changed") {
        setOutcome({ kind: "changed" })
      } else {
        setOutcome({ kind: "cannot-trust", trust: result.repository.trust })
      }
      onReload()
    } catch (cause) {
      setOutcome({ kind: "failed", message: cause instanceof Error ? cause.message : "The daemon did not answer" })
      // The daemon grants nothing when the git filters it reads are not the
      // block acknowledged. The files are read again, and a block that changed
      // says so above; trusting it is the person's next decision.
      if (gitFilters) onReload()
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="flex max-h-[min(88vh,820px)] flex-col gap-0 p-0 sm:max-w-[680px]">
        <DialogHeader className="gap-1.5 border-b px-5 pt-5 pb-4">
          <DialogTitle className="text-[16px] font-semibold tracking-[-0.01em]">
            {again ? `Trust ${name} again on ${machine}` : `Trust ${name} on ${machine}`}
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-[1.6]">{held.held === held.total
            ? "Everything this repository would run for any agent here. None of it has run."
            : `${held.held} of ${held.total} entries from this repository are held back. The rest already load.`}</DialogDescription>
        </DialogHeader>

        {/* Block flow, not a flex column or grid: a file group clips its
            corners with overflow hidden, and as a flex or grid item it would
            then shrink below its content and cut off its entries. */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {outcome?.kind === "changed" ? (
            <Alert>
              <FileTextIcon />
              <AlertTitle>The files changed while this was open</AlertTitle>
              <AlertDescription>Nothing was trusted. Read what they hold now before you trust it.</AlertDescription>
            </Alert>
          ) : null}
          {outcome?.kind === "failed" ? (
            <Alert variant="destructive">
              <FileTextIcon />
              <AlertTitle>Trust was not granted</AlertTitle>
              <AlertDescription>{outcome.message}</AlertDescription>
            </Alert>
          ) : null}
          {refused ? <TrustRefusals trust={refused} name={name} /> : null}
          {repository && incomplete ? (
            <Alert>
              <FileTextIcon />
              <AlertTitle>This list is not complete</AlertTitle>
              <AlertDescription>
                {unreadable.map((path) => <p key={path} className="m-0">{`${path} could not be read. Trust is not offered until it can be read.`}</p>)}
                {gitUnreadable ? <p className="m-0">{`The repository's Git config could not be read: ${gitConfigUnreadableText[gitUnreadable.reason]}. Trust is not offered until it can be read.`}</p> : null}
                {notShown > 0 ? <p className="m-0">{`${notShown} ${notShown === 1 ? "entry is" : "entries are"} not shown. Trust is not offered until every entry can be listed.`}</p> : null}
                {hiddenCommands > 0 ? <p className="m-0">{hiddenGitFilterText(hiddenCommands)}</p> : null}
              </AlertDescription>
            </Alert>
          ) : null}

          {inventory.state === "loading" ? (
            <div role="status" className="py-6 text-center text-sm text-muted-foreground">Reading the agents' files on the execution machine.</div>
          ) : null}
          {inventory.state === "error" ? (
            <Alert variant="destructive">
              <FileTextIcon />
              <AlertTitle>Tools could not be read</AlertTitle>
              <AlertDescription>{inventory.message}</AlertDescription>
            </Alert>
          ) : null}
          {loaded && !repository ? <p className="m-0 text-[13px] text-muted-foreground">No project is open.</p> : null}

          {repository ? (
            <>
              {groups.map((group) => <FileGroup key={group.file.path} group={group} />)}
              {gitGroups.map((group) => <GitFilterFileGroup key={group.key} group={group} />)}
              {omitted.map((provider) => (
                <p key={provider.provider} className="m-0 rounded-lg border border-dashed px-3.5 py-2.5 text-[11.5px] text-muted-foreground">{`${provider.provider}: ${omittedText(provider.omittedEntries)}`}</p>
              ))}
              {gitOmitted > 0 ? (
                <p className="m-0 rounded-lg border border-dashed px-3.5 py-2.5 text-[11.5px] text-muted-foreground">{`Git filters: ${gitOmitted} more ${gitOmitted === 1 ? "entry was" : "entries were"} left out of this list.`}</p>
              ) : null}
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg bg-sidebar px-3.5 py-2.5">
                <span className={eyebrow}>Config digest</span>
                <span className={cn(mono, "text-[10.5px] break-all text-strong")}>{repository.configDigest}</span>
              </div>
              <p className="m-0 text-[12px] text-muted-foreground">
                <span>Instruction files load either way:</span>{" "}
                <code className={cn(mono, "text-[11px] text-strong")}>CLAUDE.md · AGENTS.md</code>
              </p>
              <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-[11.5px] leading-[1.55] text-muted-foreground">
                <li>Trusted, its hooks run and its tool servers start as you, with your file and network access, when a session opens and before any tool call asks.</li>
                <li>Trust is for this machine and this repository only.</li>
                {groups.length > 0 ? <li>{pinnedText(groups.length)}</li> : null}
                {gitGroups.length > 0 ? <li>{gitConfigPinnedText}</li> : null}
                <li>Trust does not skip a gate, and its allow rules cannot either. Reads outside the worktree and gated actions still ask.</li>
                <li>If they change while this is open, nothing is trusted and the review reloads.</li>
              </ul>
            </>
          ) : null}
        </div>

        <DialogFooter className="m-0 flex-row flex-wrap items-center gap-2.5 rounded-b-xl border-t bg-sidebar px-5 py-3.5 sm:justify-start">
          {offerTrust ? (
            <Button disabled={!canTrust} onClick={() => { void trust() }}>Trust for this machine</Button>
          ) : null}
          <Button variant="outline" onClick={() => change(false)}>Keep held back</Button>
          <span className="flex-1" />
          <div className="flex flex-col items-end gap-0.5 text-right">
            <GrantedWhere />
            <span className="text-[11.5px] text-faint">After trust, start the session again.</span>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// The provider files are pinned by their content: any change counts.
function pinnedText(files: number): string {
  const which = files === 1 ? "this file" : `these ${countWord(files)} files`
  return `It is pinned to one digest of ${which}. Any change, an agent's edit included, holds it back again.`
}

// A Git config file is not: the configuration digest pins each filter and Git
// LFS setting listed (scope, key, value and required state), and the review
// digest pins the file and scope that set it. Another setting in the same file
// changes neither, so the sheet promises no more than that.
const gitConfigPinnedText = "In the Git config only the filter settings listed here are pinned, not the whole file: changing one of them, or the file that sets it, holds them back again. Other Git settings in that file are not pinned."

// One Git config file in one scope, with each filter driver it sets. The
// repository's .gitattributes decides which files a driver runs on; the
// inventory does not carry those patterns, so the group names none.
function GitFilterFileGroup({ group }: { group: GitFilterGroup }) {
  return (
    <div role="group" aria-label={group.path} className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
        <FileTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className={cn(mono, "text-[12px] font-medium break-all")}>{group.path}</span>
        <span className="text-[11.5px] text-muted-foreground">{gitFilterScopeLabel[group.scope]}</span>
        <span className="flex-1" />
        <span className="text-[11px] text-faint">{gitFilterCount(group)}</span>
      </div>
      <ul className="m-0 list-none p-0">
        {group.drivers.map((driver) => (
          <li key={driver.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t px-3.5 py-[9px]">
            <FilterIcon className="mt-px size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="w-[84px] shrink-0 text-[11.5px] text-muted-foreground">Filter driver</span>
            <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
              <span className={cn(mono, "text-[11.5px] break-all text-strong")}>{driver.driver}</span>
              <span className={cn(mono, "text-[10.5px] break-all text-faint")}>{driver.detail}</span>
              {driver.required.map((state) => <span key={state} className="text-[11px] text-faint">{gitFilterRequiredText[state]}</span>)}
              {driver.detail.includes("[REDACTED]") || driver.driver.includes("[REDACTED]")
                ? <span className="text-[11px] text-faint">Cut at a credential. Domovoi shows no secret.</span>
                : null}
            </div>
          </li>
        ))}
      </ul>
      {/* Trust pins the driver's command, not the file it runs (ruling Q205 A). */}
      <p className="m-0 border-t px-3.5 py-2.5 text-[11px] leading-[1.55] text-muted-foreground">A filter driver runs its command whenever Git checks out or stages a file. If the command runs a file in this repository, it runs whatever that file holds, an agent's edit included.</p>
    </div>
  )
}

function FileGroup({ group }: { group: RepositoryFileGroup }) {
  const { file } = group
  return (
    <div role="group" aria-label={file.path} className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
        <FileTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className={cn(mono, "text-[12px] font-medium break-all")}>{file.path}</span>
        <span className="text-[11.5px] text-muted-foreground">{toolSourceLabel[file.source]}</span>
        {group.providers.map((provider) => (
          <span key={provider} className={cn(mono, "inline-flex items-center gap-1.5 rounded-full bg-accent px-2 py-0.5 text-[10.5px] text-muted-foreground")}>
            <BotIcon className="size-3" aria-hidden />{provider}
          </span>
        ))}
        <span className="flex-1" />
        <span className="text-[11px] text-faint">{file.state === "unreadable" ? "not read" : reviewCounts(group) || "no entries"}</span>
      </div>
      {file.state === "unreadable" ? (
        <div className="flex flex-col gap-1 border-t border-danger-border bg-danger-background px-3.5 py-3 text-danger-foreground">
          <span className="text-[12.5px]">Could not read</span>
          <span className={cn(mono, "text-[10.5px] text-danger-dim")}>{file.reason}</span>
          <span className="text-[11.5px]">Its entries are not listed. Domovoi does not guess what the file holds.</span>
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {group.rows.map((row) => {
            const Icon = kindIcon[row.kind]
            return (
              <li key={row.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t px-3.5 py-[9px]">
                <Icon className="mt-px size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="w-[84px] shrink-0 text-[11.5px] text-muted-foreground">{toolKindLabel[row.kind]}</span>
                <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
                  <span className={cn(mono, "text-[11.5px] break-all text-strong")}>{row.name}</span>
                  {row.kind === "env-key"
                    ? <span className="text-[11px] text-faint">Key names only. Values are not shown.</span>
                    : row.detail ? <span className={cn(mono, "text-[10.5px] break-all text-faint")}>{row.detail}</span> : null}
                  {cutAtCredential(row) ? <span className="text-[11px] text-faint">Cut at a credential. Domovoi shows no secret.</span> : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
