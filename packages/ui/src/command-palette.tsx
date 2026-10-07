import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Command as CommandPrimitive } from "cmdk"
import { SearchIcon } from "lucide-react"

import { Button } from "./components/ui/button"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "./components/ui/command"
import type { SessionSearchMatch, SessionSearchResult, SessionSummary } from "@getdomovoi/protocol"

import { cn } from "./lib/utils"
import { startOpenerRef } from "./start-handoff"
import { StatusDot, type StatusMeaning } from "./status-dot"
import {
  commandPaletteFrame,
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
//
// Desktop V2 draws it 660px wide at 96px from the top: a plain query row with
// the scope on its right, then one line per row with a coloured dot, the label
// and the meta on the right (ruling Q375 A, 2026-10-02).

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
  // Switches the window to the machine and opens the session once it is there.
  // Says whether the switch started; a window that cannot switch closes the
  // palette at once.
  open: (machineId: string, sessionId: string) => boolean
}

// The shell's switch in flight, from a row picked on another machine.
export type PaletteSwitch = { machineId: string; sessionId: string }

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

// The design's answer dot (xmModel dotK). The status atom has no primary
// meaning, so asking takes the blue the atom has; the sweep beside it and the
// word asking carry the state.
const answerMeaning: Record<MachineAnswer["state"], StatusMeaning> = {
  asking: "handoff",
  hits: "online",
  none: "online",
  silent: "offline",
  left: "idle",
}

const answerText: Record<MachineAnswer["state"], string> = {
  asking: "text-muted-foreground",
  hits: "text-muted-foreground",
  none: "text-muted-foreground",
  silent: "text-destructive",
  left: "text-faint",
}

function age(updatedAt: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(updatedAt)) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// A session on another machine, read the way the drawer reads one here
// (session-groups.ts): a session stopped at a gate waits even while its turn
// is in flight, a failed one says so, a turn in flight is running, and the
// rest say their state. All but running say how long ago the session last
// changed. Running has no duration: the wire carries no turn start until
// protocol 0.8.0 (ruling Q390 A).
export function remoteSessionMeta(session: SessionSummary, now: number): { meaning: StatusMeaning; meta: string } {
  const stated: [StatusMeaning, string] | null =
    session.state === "waiting" ? ["waiting", "waiting"]
      : session.state === "failed" ? ["offline", "failed"]
        : session.state === "ownership-conflict" ? ["offline", "ownership conflict"]
          : null
  if (!stated && session.activeTurnId) return { meaning: "online", meta: "running" }
  const [meaning, note]: [StatusMeaning, string] = stated
    ?? (session.state === "transferred" ? ["idle", "moved to another machine"]
      : session.state === "transferring" ? ["waiting", "transferring"]
        : session.state === "done" || session.state === "archiving" || session.state === "archived" ? ["idle", session.state]
          : ["idle", "idle"])
  return { meaning, meta: `${note} ${age(session.updatedAt, now)}` }
}

// While a picked row switches the window, the answers on screen are the ones
// it was picked from: frozen, nothing is asked and nothing is cleared.
function useMachineSearch(machineSearch: MachineSearch | undefined, query: string, open: boolean, frozen: boolean) {
  const [answers, setAnswers] = useState<Record<string, MachineAnswer>>({})
  const [askedFor, setAskedFor] = useState("")
  // A machine left out stays out, later queries included, until it is added
  // back: the notice says so, and asking it again behind that would make the
  // notice untrue.
  const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(() => new Set())
  const leftOutNow = useRef<ReadonlySet<string>>(leftOut)
  // The query that was last sent out and the controller of its requests. It
  // is cleared while the next query waits out its debounce, so a machine added
  // back then is asked by that search, never for the query before it.
  const fired = useRef<{ query: string; controller: AbortController } | null>(null)
  const trimmed = query.trim()
  const active = Boolean(machineSearch) && open && (frozen || trimmed.length >= 2)
  useEffect(() => {
    fired.current = null
    if (frozen) return
    if (!machineSearch || !active) {
      setAnswers({})
      setAskedFor("")
      return
    }
    const current = new AbortController()
    const timer = setTimeout(() => {
      fired.current = { query: trimmed, controller: current }
      setAskedFor(trimmed)
      const everyMachine = [machineSearch.here, ...machineSearch.machines]
      const left = leftOutNow.current
      setAnswers(Object.fromEntries(everyMachine.map((machine) => [machine.id, left.has(machine.id) ? { state: "left" as const } : { state: "asking" as const }])))
      for (const machine of everyMachine) {
        if (!left.has(machine.id)) ask(machineSearch, machine.id, trimmed, current, setAnswers)
      }
    }, machineSearchDebounceMs)
    return () => { clearTimeout(timer); current.abort(); fired.current = null }
  }, [machineSearch, active, trimmed, frozen])
  const setLeft = (next: ReadonlySet<string>) => { leftOutNow.current = next; setLeftOut(next) }
  // Frozen, nothing can be asked, so neither action changes anything: a
  // machine added back then would be dropped from the list without a search.
  const leaveOutSilent = () => {
    if (frozen) return
    setLeft(new Set([...leftOut, ...Object.entries(answers).filter(([, answer]) => answer.state === "silent").map(([id]) => id)]))
    setAnswers((current) => Object.fromEntries(Object.entries(current).map(([id, answer]) => [id, answer.state === "silent" ? { state: "left" as const } : answer])))
  }
  const addBack = () => {
    if (frozen) return
    const returning = [...leftOut]
    setLeft(new Set())
    const current = fired.current
    // Nothing sent yet: the search waiting out its debounce asks them.
    if (!machineSearch || !current || current.controller.signal.aborted) return
    setAnswers((answered) => ({ ...answered, ...Object.fromEntries(returning.map((id) => [id, { state: "asking" as const }])) }))
    for (const id of returning) ask(machineSearch, id, current.query, current.controller, setAnswers)
  }
  const forget = () => setLeft(new Set())
  return { active, askedFor, answers, leaveOutSilent, addBack, forget }
}

function ask(
  machineSearch: MachineSearch,
  machineId: string,
  query: string,
  controller: AbortController,
  setAnswers: (update: (current: Record<string, MachineAnswer>) => Record<string, MachineAnswer>) => void,
) {
  machineSearch.search(machineId, query, controller.signal).then(
    (result) => {
      if (controller.signal.aborted) return
      setAnswers((current) => ({ ...current, [machineId]: result.matches.length ? { state: "hits", matches: result.matches, truncated: result.truncated } : { state: "none" } }))
    },
    () => {
      if (controller.signal.aborted) return
      setAnswers((current) => ({ ...current, [machineId]: { state: "silent" } }))
    },
  )
}

// A dot that repeats what the words beside it already say, or, on a command,
// is the design's colour and nothing more. It stays out of the accessibility
// tree and adds no text, so a row is read, and copied, once.
function Dot({ meaning }: { meaning: StatusMeaning }) {
  return (
    <span aria-hidden className="inline-flex shrink-0">
      <StatusDot meaning={meaning} label="" labelHidden />
    </span>
  )
}

function Sweep() {
  return (
    <span aria-hidden className="relative block h-[3px] w-9 shrink-0 overflow-hidden rounded-[3px] bg-muted">
      <span className="sweep-bar absolute inset-y-0 left-0 block w-[30%] rounded-[3px] bg-primary" />
    </span>
  )
}

const groupClass = "border-t px-2 pt-2 pb-2.5 **:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-[10.5px] **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:tracking-[.13em] **:[[cmdk-group-heading]]:text-faint"
// CommandItem appends a check mark for checkable rows; the palette has none,
// and the hidden mark would hold the meta off the right edge.
const rowClass = "gap-2.5 px-2.5 py-2 in-data-[slot=dialog-content]:rounded-[calc(var(--radius)-3px)]! data-selected:bg-accent [&>svg:last-child]:hidden"

function RowLine({ label, inSummary, end }: { label: string; inSummary?: boolean; end?: ReactNode }) {
  return (
    <>
      <span data-palette-label className="min-w-0 truncate text-[12.5px] text-foreground">{label}</span>
      <span className="flex-1" />
      {inSummary ? <span className="shrink-0 text-[11px] text-faint">in summary</span> : null}
      {end}
    </>
  )
}

export function CommandPalette({
  open,
  platform,
  commands,
  onOpenChange,
  onOpenFirstRun,
  restoreFocusTo,
  machineSearch,
  switching,
}: {
  open: boolean
  platform: CommandPalettePlatform
  commands: readonly WorkspaceCommand[]
  onOpenChange: (open: boolean) => void
  restoreFocusTo: { focus(): void } | null
  machineSearch?: MachineSearch | undefined
  // The shell's switch from a row picked on another machine, until it lands
  // on the session or is dropped.
  switching?: PaletteSwitch | null | undefined
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
  // A row picked on another machine stays on screen, marked switching, while
  // the window moves. The window's move changes the shell's search targets,
  // so the palette keeps the ones the row was picked from, and the answers it
  // was picked among, until it closes.
  const [picked, setPicked] = useState<{ machineId: string; sessionId: string; search: MachineSearch } | null>(null)
  const sawSwitch = useRef(false)
  const searching = picked?.search ?? machineSearch
  const remote = useMachineSearch(searching, query, open && !choosing, picked !== null)
  const remoteMachines = searching?.machines ?? []
  const searched = searching ? [searching.here, ...remoteMachines] : []
  const answered = searched.filter((machine) => ["hits", "none"].includes(remote.answers[machine.id]?.state ?? "")).length
  const asking = searched.some((machine) => remote.answers[machine.id]?.state === "asking")
  const silent = searched.filter((machine) => remote.answers[machine.id]?.state === "silent")
  const left = searched.filter((machine) => remote.answers[machine.id]?.state === "left")
  const total = searched.length
  const hereAnswer = searching ? remote.answers[searching.here.id] : undefined
  const inSummary = new Set(hereAnswer?.state === "hits"
    ? hereAnswer.matches.filter((match) => match.matchedIn === "summary").map((match) => `session-${match.session.id}`)
    : [])
  const summaryRows = remote.active && !choosing
    ? commands.filter((command) => inSummary.has(command.id) && !rows.includes(command))
    : []
  const remoteScope = asking
    ? `${answered} of ${total} answered, asking each machine directly`
    : left.length
      ? `searched the ${answered} ${answered === 1 ? "machine" : "machines"} that answered`
      : `searched ${answered} of ${total} machines`
  const current = highlighted || rows[0]?.id
  const elsewhere = rows.find((command) => command.id === current
    && (command.openElsewhere || canChooseMachine(command))
    && !command.disabled)
  const searchingElsewhere = remote.active && Boolean(remote.askedFor)
  // The design's groups are SESSIONS and COMMANDS. Rows with no kind tag need
  // a heading to say what they are, so machines and skills get their own.
  const groups = choosing
    ? [{ label: "MACHINES", items: rows }]
    : [
        { label: searchingElsewhere ? "SESSIONS ON THIS MACHINE" : "SESSIONS", items: [...rows.filter((command) => command.kind === "SESSION"), ...summaryRows] },
        { label: "COMMANDS", items: rows.filter((command) => !command.kind || command.kind === "PROJECT") },
        { label: "MACHINES", items: rows.filter((command) => command.kind === "MACHINE") },
        { label: "SKILLS", items: rows.filter((command) => command.kind === "SKILL") },
      ]
  const reset = () => { setQuery(""); setChoosingId(null); setHighlighted(""); setPicked(null); sawSwitch.current = false }
  // Every way out closes the same way: nothing chosen and nothing typed is
  // left behind for the next open, whichever side asked for the close.
  const close = () => { reset(); remote.forget(); onOpenChange(false) }
  const now = Date.now()

  useEffect(() => {
    if (choosingId !== null && choosing === null) reset()
  }, [choosingId, choosing])

  // The shell holds the switch until the window has arrived and asked for the
  // session, or until the intent is dropped or refused; either way the
  // palette's part is over, and activation reports its own errors.
  useEffect(() => {
    if (!picked) return
    if (switching) { sawSwitch.current = true; return }
    if (sawSwitch.current) {
      shouldRestoreFocus.current = false
      close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, switching])

  useEffect(() => {
    if (!wasOpen.current && open) shouldRestoreFocus.current = true
    if (wasOpen.current && !open) {
      reset()
      remote.forget()
      if (shouldRestoreFocus.current) queueMicrotask(() => restoreCommandPaletteFocus(restoreFocusTo))
    }
    wasOpen.current = open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, restoreFocusTo])

  const notice = (key: string, meaning: StatusMeaning, text: string, action: string, onClick: () => void) => (
    // The list's own key handling runs the highlighted row on Enter; Enter
    // pressed on the notice's button belongs to the button. Every other key,
    // the palette's toggle among them, goes on as usual.
    <div key={key} data-palette-notice onKeyDown={(event) => { if (event.key === "Enter") event.stopPropagation() }} className="mx-0.5 mt-0.5 mb-1.5 flex items-center gap-2.5 rounded-[calc(var(--radius)-2px)] border bg-background px-3 py-[9px]">
      <Dot meaning={meaning} />
      <span className="min-w-0 flex-1 text-[12px] leading-normal text-strong">{text}</span>
      <Button type="button" variant="outline" size="xs" className="shrink-0" disabled={picked !== null} onClick={onClick}>{action}</Button>
    </div>
  )

  return (
    <CommandDialog
      className={commandPaletteFrame}
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
        className="rounded-none! bg-transparent p-0"
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
        <div data-palette-query className="flex items-center gap-2.5 border-b px-4 py-3.5">
          <SearchIcon aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-faint" />
          <CommandPrimitive.Input
            autoFocus
            aria-label="Search commands"
            placeholder="Search commands"
            value={query}
            onValueChange={setQuery}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-strong outline-hidden placeholder:text-faint"
          />
          {!choosing ? (
            <span className="shrink-0 font-machine text-[10.5px] text-faint">
              {remote.active ? "titles and summaries, every machine" : "sessions, machines, commands, skills"}
            </span>
          ) : null}
        </div>
        <CommandList className="max-h-[min(30rem,calc(100dvh-14rem))] scroll-py-2">
          <CommandEmpty>No matching commands.</CommandEmpty>
          {groups.map(({ label, items }) => {
            return items.length ? (
              <CommandGroup key={label} heading={label} className={groupClass}>
                {items.map((command) => {
                  const meta = command.kind
                    ? command.meta
                    : command.shortcut ? undefined : command.detail
                  return (
                    <CommandItem
                      key={command.id}
                      {...(command.disabled === undefined ? {} : { disabled: command.disabled })}
                      {...(command.opensStart ? { ref: startOpenerRef } : {})}
                      value={command.id}
                      className={rowClass}
                      onSelect={() => {
                        if (command.disabled) return
                        shouldRestoreFocus.current = command.restoreFocus !== false
                        close()
                        command.run()
                      }}
                    >
                      {command.kind ? (
                        // An entity's dot is its state, and the row says it
                        // nowhere else, so the label stays readable.
                        <StatusDot
                          meaning={command.tone ?? "idle"}
                          label={`${command.kind.toLowerCase()}, ${command.tone ?? "idle"}`}
                          labelHidden
                          className="shrink-0"
                        />
                      ) : <Dot meaning={command.tone ?? "idle"} />}
                      <RowLine
                        label={command.label}
                        inSummary={inSummary.has(command.id)}
                        end={command.shortcut ? (
                          // The design draws a shortcut in the meta's place.
                          <kbd data-palette-meta className="shrink-0 font-machine text-[10.5px] text-faint">{shortcutLabel(command.shortcut, platform)}</kbd>
                        ) : meta ? (
                          <span data-palette-meta className="shrink-0 font-machine text-[10.5px] text-faint">{meta}</span>
                        ) : null}
                      />
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : null
          })}
          {searchingElsewhere && searching ? (
            <CommandGroup
              forceMount
              className={cn(groupClass, "**:[[cmdk-group-heading]]:flex **:[[cmdk-group-heading]]:items-center **:[[cmdk-group-heading]]:gap-2.5")}
              heading={(
                <>
                  <span>SESSIONS ON OTHER MACHINES</span>
                  <span className="flex-1" />
                  <span className="text-[11px] font-normal tracking-normal">{remoteScope}</span>
                </>
              )}
            >
              {silent.length ? notice(
                "silent",
                "offline",
                silent.length === 1
                  ? `${silent[0]!.label} did not answer, so its sessions were not searched.`
                  : `${listOfNames(silent.map((machine) => machine.label))} did not answer, so their sessions were not searched.`,
                "Search only what answered",
                remote.leaveOutSilent,
              ) : null}
              {left.length ? notice(
                "left",
                "idle",
                left.length === 1
                  ? `${left[0]!.label} is left out, so its sessions stay unsearched until you add it back.`
                  : `${listOfNames(left.map((machine) => machine.label))} are left out, so their sessions stay unsearched until you add them back.`,
                left.length === 1 ? "Add it back" : "Add them back",
                remote.addBack,
              ) : null}
              {remoteMachines.map((machine) => {
                const answer = remote.answers[machine.id] ?? { state: "asking" as const }
                return (
                  <div key={machine.id} role="group" aria-label={machine.label} className="flex flex-col">
                    <div className="flex items-center gap-2 px-2.5 pt-[7px] pb-[5px]">
                      <Dot meaning={answerMeaning[answer.state]} />
                      <span className="font-machine text-[11px] text-strong">{machine.label}</span>
                      <span className="text-[11px] text-faint">{machine.transport}</span>
                      <span className="flex-1" />
                      {answer.state === "asking" ? <Sweep /> : null}
                      <span className={cn("text-[11px]", answerText[answer.state])}>{answerLabel(answer)}</span>
                    </div>
                    {answer.state === "hits" ? answer.matches.map((match) => {
                      const row = remoteSessionMeta(match.session, now)
                      const isPicked = picked?.machineId === machine.id && picked.sessionId === match.session.id
                      return (
                        <CommandItem
                          key={`${machine.id}:${match.session.id}`}
                          value={`remote:${machine.id}:${match.session.id}`}
                          className={cn(rowClass, "pl-[25px]", isPicked && "bg-accent")}
                          onSelect={() => {
                            if (picked) return
                            const started = searching.open(machine.id, match.session.id)
                            if (!started) {
                              shouldRestoreFocus.current = false
                              close()
                              return
                            }
                            setPicked({ machineId: machine.id, sessionId: match.session.id, search: searching })
                          }}
                        >
                          <Dot meaning={row.meaning} />
                          <RowLine
                            label={match.session.title}
                            inSummary={match.matchedIn === "summary"}
                            end={isPicked ? (
                              <>
                                <Sweep />
                                <span className="shrink-0 font-machine text-[10.5px] text-muted-foreground">switching to {machine.label}</span>
                              </>
                            ) : (
                              <span data-palette-meta className="shrink-0 font-machine text-[10.5px] text-faint">{row.meta}</span>
                            )}
                          />
                        </CommandItem>
                      )
                    }) : null}
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
