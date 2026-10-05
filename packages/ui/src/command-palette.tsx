import { useEffect, useMemo, useRef, useState } from "react"

import { Button } from "./components/ui/button"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command"
import type { SessionSearchMatch, SessionSearchResult } from "@getdomovoi/protocol"

import { startOpenerRef } from "./start-handoff"
import { StatusDot } from "./status-dot"
import {
  commandPaletteTitle,
  opensElsewhere,
  rankWorkspaceCommands,
  shortcutLabel,
  type CommandPalettePlatform,
  type WorkspaceCommand,
} from "./workspace-commands"

// The palette draws the commands workspace-commands.ts builds. Nothing on the
// first screen needs it, so the shell loads this module the first time the
// palette opens, and at idle once the shell has painted.

// A session with somewhere to go. An empty target list is a session that
// cannot move, and offering it a picker with nothing in it says otherwise.
function canChooseMachine(command: WorkspaceCommand): boolean {
  return (command.elsewhereTargets?.length ?? 0) > 0
}

export function restoreCommandPaletteFocus(target: { focus(): void } | null): void {
  target?.focus()
}

// J39 (2026-09-23): the palette asks every admitted machine directly for
// sessions whose title or summary match, and says what each one answered.
// Not answering is shown as not searched, never as no results.
export type MachineSearch = {
  // The window's own machine. Searched like the others and counted by its
  // answer; its summary matches join the SESSIONS group.
  here: { id: string; label: string }
  machines: readonly { id: string; label: string; transport: string }[]
  search: (machineId: string, query: string, signal: AbortSignal) => Promise<SessionSearchResult>
  open: (machineId: string, sessionId: string) => void
}

type MachineAnswer =
  | { state: "asking" }
  | { state: "hits"; matches: SessionSearchMatch[]; truncated: boolean }
  | { state: "none" }
  | { state: "silent" }
  | { state: "left" }

const machineSearchDebounceMs = 250

function listOfNames(names: readonly string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}

function answerLabel(answer: MachineAnswer): string {
  switch (answer.state) {
    case "asking": return "asking"
    case "hits": return answer.truncated
      ? `first ${answer.matches.length} ${answer.matches.length === 1 ? "match" : "matches"}, more not shown`
      : `${answer.matches.length} ${answer.matches.length === 1 ? "match" : "matches"}`
    case "none": return "no matches"
    case "silent": return "not searched, did not answer"
    case "left": return "not searched, left out"
  }
}

function useMachineSearch(machineSearch: MachineSearch | undefined, query: string, open: boolean) {
  const [answers, setAnswers] = useState<Record<string, MachineAnswer>>({})
  const [askedFor, setAskedFor] = useState("")
  const trimmed = query.trim()
  const active = Boolean(machineSearch) && open && trimmed.length >= 2
  useEffect(() => {
    if (!machineSearch || !active) {
      setAnswers({})
      setAskedFor("")
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setAskedFor(trimmed)
      const everyMachine = [machineSearch.here, ...machineSearch.machines]
      setAnswers(Object.fromEntries(everyMachine.map((machine) => [machine.id, { state: "asking" as const }])))
      for (const machine of everyMachine) {
        machineSearch.search(machine.id, trimmed, controller.signal).then(
          (result) => {
            if (controller.signal.aborted) return
            setAnswers((current) => ({ ...current, [machine.id]: result.matches.length ? { state: "hits", matches: result.matches, truncated: result.truncated } : { state: "none" } }))
          },
          () => {
            if (controller.signal.aborted) return
            setAnswers((current) => ({ ...current, [machine.id]: { state: "silent" } }))
          },
        )
      }
    }, machineSearchDebounceMs)
    return () => { clearTimeout(timer); controller.abort() }
  }, [machineSearch, active, trimmed])
  const leaveOutSilent = () => setAnswers((current) => Object.fromEntries(Object.entries(current).map(([id, answer]) => [id, answer.state === "silent" ? { state: "left" as const } : answer])))
  return { active, askedFor, answers, leaveOutSilent }
}

export function CommandPalette({
  open,
  platform,
  commands,
  onOpenChange,
  onOpenFirstRun,
  restoreFocusTo,
  machineSearch,
}: {
  open: boolean
  platform: CommandPalettePlatform
  commands: readonly WorkspaceCommand[]
  onOpenChange: (open: boolean) => void
  restoreFocusTo: { focus(): void } | null
  machineSearch?: MachineSearch | undefined
  // Setting a machine up is not a command: it is the thing you reach for when
  // no command here can help yet.
  onOpenFirstRun?: (() => void) | undefined
}) {
  const [query, setQuery] = useState("")
  // cmdk reports the highlighted row by its value, and the value is the command
  // id, so the footer can say what the modified key would do on this row rather
  // than advertising it everywhere and doing nothing on most rows.
  const [highlighted, setHighlighted] = useState("")
  const wasOpen = useRef(open)
  const shouldRestoreFocus = useRef(true)
  const ranked = useMemo(() => rankWorkspaceCommands(commands, query), [commands, query])
  // cmdk highlights the first row on open and only tells us once the selection
  // moves, so an empty report means the first row.
  // While a session is choosing a machine, the list is that session's targets.
  // The session is held by id and looked up in the commands of this render, so
  // a target the list no longer offers cannot run, and a session that has left
  // the list takes the picker with it.
  const [choosingId, setChoosingId] = useState<string | null>(null)
  const choosing = choosingId === null
    ? null
    : commands.find((command) => command.id === choosingId && canChooseMachine(command)) ?? null
  const targets = useMemo(
    () => (choosing ? rankWorkspaceCommands(choosing.elsewhereTargets!, query) : null),
    [choosing, query],
  )
  const rows = targets ?? ranked
  const remote = useMachineSearch(machineSearch, query, open && !choosing)
  const remoteMachines = machineSearch?.machines ?? []
  const searched = machineSearch ? [machineSearch.here, ...remoteMachines] : []
  const answered = searched.filter((machine) => ["hits", "none"].includes(remote.answers[machine.id]?.state ?? "")).length
  const asking = searched.some((machine) => remote.answers[machine.id]?.state === "asking")
  const silent = searched.filter((machine) => remote.answers[machine.id]?.state === "silent")
  const leftOut = searched.some((machine) => remote.answers[machine.id]?.state === "left")
  const total = searched.length
  const hereAnswer = machineSearch ? remote.answers[machineSearch.here.id] : undefined
  const inSummary = new Set(hereAnswer?.state === "hits"
    ? hereAnswer.matches.filter((match) => match.matchedIn === "summary").map((match) => `session-${match.session.id}`)
    : [])
  const summaryRows = remote.active && !choosing
    ? commands.filter((command) => inSummary.has(command.id) && !rows.includes(command))
    : []
  const remoteScope = asking
    ? `${answered} of ${total} answered, asking each machine directly`
    : leftOut
      ? `searched the ${answered} ${answered === 1 ? "machine" : "machines"} that answered`
      : `searched ${answered} of ${total} machines`
  const current = highlighted || rows[0]?.id
  const elsewhere = rows.find((command) => command.id === current
    && (command.openElsewhere || canChooseMachine(command))
    && !command.disabled)
  const groups = choosing
    ? [{ label: "MACHINES", items: rows }]
    : [
        { label: "SESSIONS", items: [...rows.filter((command) => command.kind === "SESSION"), ...summaryRows] },
        { label: "COMMANDS", items: rows.filter((command) => command.kind !== "SESSION") },
      ]
  const reset = () => { setQuery(""); setChoosingId(null); setHighlighted("") }
  // Every way out closes the same way: nothing chosen and nothing typed is
  // left behind for the next open, whichever side asked for the close.
  const close = () => { reset(); onOpenChange(false) }

  useEffect(() => {
    if (choosingId !== null && choosing === null) reset()
  }, [choosingId, choosing])

  useEffect(() => {
    if (!wasOpen.current && open) shouldRestoreFocus.current = true
    if (wasOpen.current && !open) {
      reset()
      if (shouldRestoreFocus.current) queueMicrotask(() => restoreCommandPaletteFocus(restoreFocusTo))
    }
    wasOpen.current = open
  }, [open, restoreFocusTo])

  return (
    <CommandDialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Escape backs out of a half-made choice before it closes the whole
        // launcher. The dialog owns the key, so the step back happens here.
        if (!nextOpen && choosing) {
          reset()
          return
        }
        if (!nextOpen) { close(); return }
        onOpenChange(nextOpen)
      }}
      title={commandPaletteTitle}
      description="Navigate Domovoi and run common session actions."
    >
      <Command
        shouldFilter={false}
        loop
        value={current ?? ""}
        onValueChange={setHighlighted}
        onKeyDown={(event) => {
          // cmdk's own Enter handler carries no modifiers, so the modified key
          // is read here and stopped before it reaches the default.
          if (!opensElsewhere(event, platform)) return
          // The modified key never falls through to the plain action. Running
          // Enter's job because this row cannot go elsewhere would be a worse
          // answer than doing nothing, and the footer already says which it is.
          event.preventDefault()
          if (!elsewhere) return
          if (canChooseMachine(elsewhere)) {
            // The launcher picks the machine. The preflight takes the decision.
            setChoosingId(elsewhere.id)
            setQuery("")
            setHighlighted("")
            return
          }
          shouldRestoreFocus.current = elsewhere.restoreFocus !== false
          close()
          elsewhere.openElsewhere!()
        }}
      >
        <CommandInput
          autoFocus
          aria-label="Search commands"
          placeholder="Search commands"
          value={query}
          onValueChange={setQuery}
        />
        {!choosing ? (
          <p className="m-0 border-b px-3 py-1.5 text-eyebrow text-faint">
            {remote.active ? "titles and summaries, every machine" : "sessions, machines, commands, skills"}
          </p>
        ) : null}
        <CommandList>
          <CommandEmpty>No matching commands.</CommandEmpty>
          {groups.map(({ label, items }) => {
            return items.length ? (
              <CommandGroup key={label} heading={label}>
                {items.map((command) => {
                  const Icon = command.icon
                  return (
                    <CommandItem
                      key={command.id}
                      {...(command.disabled === undefined ? {} : { disabled: command.disabled })}
                      {...(command.opensStart ? { ref: startOpenerRef } : {})}
                      value={command.id}
                      onSelect={() => {
                        if (command.disabled) return
                        shouldRestoreFocus.current = command.restoreFocus !== false
                        close()
                        command.run()
                      }}
                    >
                      {command.kind ? (
                        <StatusDot
                          meaning={command.tone ?? "idle"}
                          label={`${command.kind.toLowerCase()}, ${command.tone ?? "idle"}`}
                          size="default"
                          labelHidden
                          data-testid="entity-dot"
                          className="shrink-0"
                        />
                      ) : Icon ? <Icon /> : null}
                      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{command.label}</span>
                          {inSummary.has(command.id) ? <span className="shrink-0 rounded-full bg-muted px-1.5 font-machine text-mono-xs text-muted-foreground">in summary</span> : null}
                        </span>
                        {command.meta ? (
                          <span className="truncate font-machine text-mono-xs text-muted-foreground">{command.meta}</span>
                        ) : null}
                      </span>
                      {command.detail && !command.kind ? (
                        <span className="shrink-0 font-machine text-[10px] text-faint">{command.detail}</span>
                      ) : null}
                      {command.kind ? (
                        <span className="shrink-0 text-eyebrow text-faint">{command.kind}</span>
                      ) : null}
                      {/* The design draws a shortcut in the same meta column as a
                          text meta, so it shares the detail's place and type. */}
                      {command.shortcut ? (
                        <kbd className="shrink-0 font-machine text-[10px] text-faint">{shortcutLabel(command.shortcut, platform)}</kbd>
                      ) : null}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : null
          })}
          {remote.active && remote.askedFor && machineSearch ? (
            <CommandGroup heading="SESSIONS ON OTHER MACHINES" forceMount>
              <p className="m-0 px-2 pb-1 font-machine text-mono-xs text-faint">{remoteScope}</p>
              {silent.length ? (
                <div className="mx-2 mb-2 flex flex-col gap-2 rounded-md border border-danger-border bg-danger-background px-3 py-2 text-[11.5px] text-danger-foreground">
                  <span>{listOfNames(silent.map((machine) => machine.label))}{silent.length === 1 ? " did not answer, so its sessions were not searched." : " did not answer, so their sessions were not searched."} This is not the same as having no results, and Domovoi will not round it down to one.</span>
                  <Button type="button" variant="outline" size="xs" className="self-start" onClick={remote.leaveOutSilent}>Search only what answered</Button>
                </div>
              ) : null}
              {remoteMachines.map((machine) => {
                const answer = remote.answers[machine.id] ?? { state: "asking" as const }
                return (
                  <div key={machine.id} role="group" aria-label={machine.label} className="flex flex-col">
                    <div className="flex items-center gap-2 px-2 py-1 text-[11px]">
                      <span className="font-machine text-strong">{machine.label}</span>
                      <span className="font-machine text-mono-xs text-faint">{machine.transport}</span>
                      <span className="flex-1" />
                      <span className={answer.state === "silent" ? "text-destructive" : "text-faint"}>{answerLabel(answer)}</span>
                    </div>
                    {answer.state === "hits" ? answer.matches.map((match) => (
                      <CommandItem
                        key={`${machine.id}:${match.session.id}`}
                        value={`remote:${machine.id}:${match.session.id}`}
                        className="pl-6"
                        onSelect={() => {
                          shouldRestoreFocus.current = false
                          close()
                          machineSearch.open(machine.id, match.session.id)
                        }}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="truncate">{match.session.title}</span>
                          {match.matchedIn === "summary" ? <span className="shrink-0 rounded-full bg-muted px-1.5 font-machine text-mono-xs text-muted-foreground">in summary</span> : null}
                        </span>
                        <span className="shrink-0 font-machine text-mono-xs text-faint">{match.session.state}</span>
                      </CommandItem>
                    )) : null}
                  </div>
                )
              })}
            </CommandGroup>
          ) : null}
        </CommandList>
        <div className="flex items-center gap-3 border-t px-3 py-2">
        <p data-testid="palette-hints" className="m-0 flex-1 font-machine text-mono-xs text-muted-foreground">
          {choosing
            ? `↑↓ navigate · Enter move ${choosing.label} here · Escape back`
            : `↑↓ navigate · Enter run${elsewhere ? ` · ${platform === "darwin" ? "⌘" : "Ctrl"}+Enter open elsewhere` : ""} · Escape close · ${platform === "darwin" ? "⌘K" : "Ctrl+K"} toggle`}
        </p>
        {onOpenFirstRun && !choosing ? (
          <button
            type="button"
            className="shrink-0 text-[11px] text-primary"
            onClick={() => {
              shouldRestoreFocus.current = false
              close()
              onOpenFirstRun()
            }}
          >
            First-run setup
          </button>
        ) : null}
        </div>
      </Command>
    </CommandDialog>
  )
}
