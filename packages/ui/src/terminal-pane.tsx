import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { CircleStopIcon, TerminalSquareIcon, XIcon } from "lucide-react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

import { maximumTerminalReplayCharacters } from "@getdomovoi/protocol"
import type {
  TerminalClosedNotification,
  TerminalOutputNotification,
  TerminalOwner,
  TerminalOwnershipNotification,
  TerminalResizedNotification,
  TerminalSession,
  TerminalSummary,
  TerminalWatchResult,
} from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { composerInbox, type ComposerInbox } from "./composer-inbox"
import { terminalOutputAttachment } from "./desktop-attachments"
import { readingTime } from "./fleet-access-session"
import { StatusDot, type StatusMeaning } from "./status-dot"
import { terminalIdForSession } from "./terminal-id"
import { settleTerminalWrite } from "./terminal-input"
import { terminalQuickKeyData, terminalQuickKeys } from "./terminal-keys"
import { terminalAttachmentText } from "./terminal-output-text"

export type TerminalControls = {
  clientId: string
  create(
    sessionId: string,
    dimensions: { cols: number; rows: number },
    terminalId: string,
  ): Promise<TerminalSession>
  claim(terminalId: string): Promise<TerminalOwnershipNotification>
  // terminal.release: the holder gives up its claim and the shell keeps
  // running with nobody holding it. A client without it offers no release.
  release?(terminalId: string): Promise<TerminalOwnershipNotification>
  write(terminalId: string, data: string): Promise<void>
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  close(terminalId: string): Promise<void>
  subscribe(
    terminalId: string,
    handlers: {
      output: (event: TerminalOutputNotification) => void
      closed: (event: TerminalClosedNotification) => void
      ownership: (event: TerminalOwnershipNotification) => void
      // terminal.resized, sent only to a watch that asked with followResize.
      resized: (event: TerminalResizedNotification) => void
    },
  ): () => void
  // terminal.list: who holds each of a session's shells, whether that
  // connection is still there, and the grid it set.
  list?(sessionId: string): Promise<TerminalSummary[]>
} & (
  // Reading without holding: terminal.watch and terminal.unwatch, as a pair,
  // because a watch that cannot be undone keeps this connection in the
  // shell's audience after the pane is gone. A client that cannot watch
  // leaves both out, and a read-only pane shows its empty state instead.
  // followResize asks for terminal.resized; followsResize in the reply says
  // the daemon accepted it. A daemon from before the notice does not.
  | {
    watch(
      terminalId: string,
      options?: { followResize: true },
    ): Promise<TerminalWatchResult & { followsResize?: boolean }>
    unwatch(terminalId: string): Promise<void>
  }
  | { watch?: never, unwatch?: never }
)

// The interval at which a pane that does not hold the shell reads the holder
// again. The daemon sends no notice when the holder's connection drops, so
// between reads (this interval plus the reply's time, or longer when a read
// fails or the page throttles timers) the banner can name a holder that has
// gone. A watch the daemon sends terminal.resized for takes the grid from that
// notice; any other pane also takes it from these reads, so until the next one
// its output can draw at the holder's previous grid.
export const terminalHolderRefreshMs = 5_000

// The pane's xterm history, in rows. Once the normal buffer holds this many
// rows plus the screen's, xterm drops the oldest row for each new one.
const terminalScrollback = 5_000

function sameOwner(left: TerminalOwner, right: TerminalOwner): boolean {
  return left.client === right.client
    && left.clientId === right.clientId
    && left.device?.id === right.device?.id
    && left.claimedAt === right.claimedAt
}

// The states the pane can be in, each with the atom's meaning for it. Keyed on
// the union the status is computed from, so another state fails typecheck
// rather than rendering no dot. "no shell" and "unavailable" are answers: once
// the daemon has replied, the pane is not connecting any more.
type TerminalStatus = "closed" | "connected" | "connecting" | "disconnected" | "no shell" | "unavailable"
const terminalStatusMeaning: Record<TerminalStatus, StatusMeaning> = {
  closed: "idle",
  connected: "online",
  connecting: "waiting",
  disconnected: "offline",
  "no shell": "idle",
  unavailable: "offline",
}

// Who holds the shell, when the claimant's device has no label: the claim
// names the client kind it came from and nothing more.
const clientNoun: Record<TerminalOwner["client"], string> = {
  desktop: "a desktop",
  web: "a browser",
  tablet: "a tablet",
  phone: "a phone",
  cli: "the command line",
}

// The daemon's reply when a session has no shell open. It is a state the
// watching desktop shows, not an error.
const terminalMissing = "Terminal does not exist"

// What a refusal says. An RPC error may carry an empty message, and an empty
// error would leave the pane with nothing to show and its status unsettled.
function failure(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback
}

type AttachNote = { tone: "done" | "refused", text: string }

export function TerminalPane({
  composer = composerInbox,
  connected,
  controls,
  historyRows = terminalScrollback,
  holderRefreshMs = terminalHolderRefreshMs,
  readOnly = false,
  machineName,
  sessionId,
}: {
  composer?: ComposerInbox
  connected: boolean
  controls: TerminalControls
  // xterm's scrollback, in rows. Tests shorten it so filling it is cheap.
  historyRows?: number
  holderRefreshMs?: number
  readOnly?: boolean
  machineName: string
  sessionId: string | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  // Set once the history has filled, and kept: a later clear or resize shrinks
  // the buffer again, but rows that scrolled out do not come back.
  const historyFilledRef = useRef(false)
  const terminalId = useMemo(
    () => sessionId ? terminalIdForSession(sessionId) : undefined,
    [sessionId],
  )
  const [metadata, setMetadata] = useState<TerminalSession>()
  const [claimHeld, setClaimHeld] = useState(true)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState("")
  const [closed, setClosed] = useState(false)
  const [restartKey, setRestartKey] = useState(0)
  const [attachNote, setAttachNote] = useState<AttachNote>()
  const [releasing, setReleasing] = useState(false)
  // The mounted renderer's ownership handler, for this pane's own claim and
  // release replies.
  const applyOwnershipRef = useRef<((ownership: TerminalOwnershipNotification) => void) | undefined>(undefined)
  // Counts the renderers the pane has mounted, so a reply can tell whether
  // the pane still shows the shell it asked about.
  const generationRef = useRef(0)
  // Whether an xterm is mounted to read output from. A disconnect disposes it
  // while the last metadata stays on screen.
  const [rendered, setRendered] = useState(false)
  // terminal.watch said the record does not start at the shell's start.
  const [earlierDropped, setEarlierDropped] = useState(false)
  // terminal.create's record reached the replay limit. That reply has no
  // dropped flag, so the start may or may not have gone.
  const [recordFull, setRecordFull] = useState(false)
  const watching = readOnly && controls.watch !== undefined && controls.unwatch !== undefined
  const canAttach = useSyncExternalStore(
    composer.subscribe,
    () => composer.canReceive(sessionId),
    () => false,
  )

  useEffect(() => {
    // A claim or release answered after this point belongs to the pane as it
    // was, not to whatever shell it shows next.
    generationRef.current += 1
    const container = containerRef.current
    if (!container || !connected || !sessionId || !terminalId) return
    const watch = controls.watch
    const unwatch = controls.unwatch
    // Untyped callers can still pass half the pair; never watch without a
    // way to stop.
    if (readOnly && (!watch || !unwatch)) return
    let active = true
    let attached = false
    let ownsTerminal = false
    setMetadata(undefined)
    setClaimHeld(true)
    setMissing(false)
    setError("")
    setClosed(false)
    setReleasing(false)
    setAttachNote(undefined)
    setEarlierDropped(false)
    setRecordFull(false)
    const styles = getComputedStyle(container)
    const terminal = new Terminal({
      cursorBlink: !readOnly,
      disableStdin: true,
      fontFamily: "JetBrains Mono Variable, JetBrains Mono, monospace",
      fontSize: 11,
      lineHeight: 1.85,
      screenReaderMode: true,
      scrollback: historyRows,
      theme: {
        background: styles.getPropertyValue("--code").trim() || "#151515",
        foreground: styles.getPropertyValue("--foreground").trim() || "#eeeeec",
        cursor: styles.getPropertyValue("--primary").trim() || "#ee8f35",
        selectionBackground: styles.getPropertyValue("--accent").trim() || "#333333",
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    xtermRef.current = terminal
    setRendered(true)
    fit.fit()
    // Whether the history has filled, so its oldest rows may have gone. Taken
    // on the normal buffer (the alternate screen keeps no history) at every
    // point rows can be pushed out: a line feed or any other scroll, both
    // inside the parse so a clear later in the same write cannot hide it, and
    // either side of a resize, whose reflow can push rows out too.
    historyFilledRef.current = false
    // A resize to fewer rows lowers the capacity before reflow, so it is
    // checked against the smaller of the two heights.
    const noteHistory = (rows = terminal.rows) => {
      if (terminal.buffer.normal.length >= historyRows + Math.min(rows, terminal.rows)) historyFilledRef.current = true
    }
    const fed = terminal.onLineFeed(() => noteHistory())
    const scrolled = terminal.onScroll(() => noteHistory())
    const resizeTo = (cols: number, rows: number) => {
      noteHistory(rows)
      terminal.resize(cols, rows)
      noteHistory()
    }
    const refit = () => {
      noteHistory(fit.proposeDimensions()?.rows)
      fit.fit()
      noteHistory()
    }
    // Whether the daemon sends this pane terminal.resized, so the grid comes
    // from that notice and not from the holder reads below.
    let followsResize = false
    // An ownership notice, or the reply to this pane's own claim or release:
    // the reply settles the claim even if the notice is still on its way.
    const applyOwnership = ({ owner, claimHeld, terminalId: named }: TerminalOwnershipNotification) => {
      // A reply can arrive after the pane moved to another session's shell.
      if (named !== terminalId) return
      // A release names the last holder with claimHeld false. A daemon from
      // before release omits claimHeld, and its notices always mean held.
      const held = claimHeld ?? true
      // A watcher never holds the shell, whatever the notification says.
      const owned = ownsTerminal
      ownsTerminal = !readOnly && held && owner.clientId === controls.clientId
      terminal.options.disableStdin = !ownsTerminal
      // Taking the shell makes this pane's grid the shell's grid.
      if (ownsTerminal && !owned && attached) {
        refit()
        void controls.resize(terminalId, terminal.cols, terminal.rows).catch(() => undefined)
      }
      setClaimHeld(held)
      setMetadata((current) => current ? { ...current, owner } : current)
    }
    applyOwnershipRef.current = applyOwnership
    const unsubscribe = controls.subscribe(terminalId, {
      output: ({ data }) => terminal.write(data),
      closed: ({ exitCode }) => {
        setClosed(true)
        terminal.write(`\r\n[process exited${exitCode === undefined ? "" : ` ${exitCode}`}]\r\n`)
      },
      ownership: applyOwnership,
      resized: ({ cols, rows }) => {
        if (!attached || ownsTerminal) return
        // xterm parses writes later, and a resize applies at once. Resizing
        // once the output queued before the notice is parsed keeps that output
        // at the grid it was printed for.
        terminal.write("", () => {
          if (active && !ownsTerminal) resizeTo(cols, rows)
        })
      },
    })
    const input = terminal.onData((data) => {
      if (!ownsTerminal) return
      void controls.write(terminalId, data).catch((cause: unknown) => {
        if (active) setError(failure(cause, "Terminal input failed"))
      })
    })
    // The shell has one grid, the holder's. A pane that does not hold it draws
    // at that grid rather than its own width, or every cursor-positioned
    // character the shell prints lands in the wrong column.
    const observer = new ResizeObserver(() => {
      if (attached && !ownsTerminal) return
      refit()
      if (!attached) return
      void controls.resize(terminalId, terminal.cols, terminal.rows).catch(() => undefined)
    })
    observer.observe(container)
    // Nothing on the wire says when the holder's connection drops, so a pane
    // that does not hold the shell reads the holder from terminal.list on an
    // interval. Replies come in order on one connection, so a reply never
    // undoes an ownership notice that arrived before it. A pane the daemon
    // sends no terminal.resized reads the holder's grid here too; one it does
    // takes the grid from the notice, which is ordered with the output and
    // the list reply is not.
    const list = controls.list
    const holderRefresh = list ? setInterval(() => {
      if (!attached || ownsTerminal) return
      void list(sessionId).then((terminals) => {
        if (!active || ownsTerminal) return
        const current = terminals.find((candidate) => candidate.terminalId === terminalId)
        if (!current || current.state !== "live") return
        setClaimHeld(current.claimHeld)
        setMetadata((shown) => shown && !sameOwner(shown.owner, current.owner) ? { ...shown, owner: current.owner } : shown)
        if (!followsResize && (terminal.cols !== current.cols || terminal.rows !== current.rows)) resizeTo(current.cols, current.rows)
      }, () => undefined)
    }, holderRefreshMs) : undefined
    // Settles once the watch has its answer. The client can ask a second time
    // (without followResize, for an older daemon), so an unwatch sent before
    // the answer could reach the daemon ahead of that second watch.
    let watchAnswered: Promise<void> | undefined
    let watchSettled = false
    if (readOnly && watch) {
      // The watching desktop reads the shell the way the phone does: the
      // daemon's kept record, then what it prints from here on. Nothing it
      // does reaches the process, and it never opens a shell of its own.
      watchAnswered = watch(terminalId, { followResize: true }).then(
        (record) => {
          watchSettled = true
          if (!active) return
          attached = true
          followsResize = record.followsResize === true
          const { buffer, claimHeld: held, cols, cwd, owner, rows, shell, state } = record
          setMetadata({ terminalId, sessionId, cols, rows, shell, cwd, buffer, owner })
          setClaimHeld(held)
          resizeTo(cols, rows)
          setEarlierDropped(record.earlierOutputDropped)
          if (buffer) terminal.write(buffer)
          if (state === "closed") {
            setClosed(true)
            terminal.write(`\r\n[process exited${record.exitCode === undefined ? "" : ` ${record.exitCode}`}]\r\n`)
          }
        },
        (cause: unknown) => {
          watchSettled = true
          if (!active) return
          const message = failure(cause, "Terminal could not be read")
          if (message === terminalMissing) setMissing(true)
          else setError(message)
        },
      )
    } else {
      void controls.create(
        sessionId,
        { cols: terminal.cols, rows: terminal.rows },
        terminalId,
      ).then(
        (session) => {
          if (!active) return
          attached = true
          ownsTerminal = session.owner.clientId === controls.clientId
          terminal.options.disableStdin = !ownsTerminal
          setMetadata(session)
          // The daemon keeps the last maximumTerminalReplayCharacters
          // characters, so a record that long may be missing its start.
          setRecordFull(session.buffer.length >= maximumTerminalReplayCharacters)
          if (!ownsTerminal) resizeTo(session.cols, session.rows)
          if (session.buffer) terminal.write(session.buffer)
          if (ownsTerminal) {
            void controls.resize(terminalId, terminal.cols, terminal.rows).catch(() => undefined)
            terminal.focus()
          }
        },
        (cause: unknown) => {
          if (active) setError(failure(cause, "Terminal could not start"))
        },
      )
    }
    return () => {
      active = false
      if (applyOwnershipRef.current === applyOwnership) applyOwnershipRef.current = undefined
      if (holderRefresh !== undefined) clearInterval(holderRefresh)
      setRendered(false)
      unsubscribe()
      observer.disconnect()
      input.dispose()
      fed.dispose()
      scrolled.dispose()
      terminal.dispose()
      if (xtermRef.current === terminal) xtermRef.current = null
      if (readOnly && unwatch) {
        const stop = () => void unwatch(terminalId).catch(() => undefined)
        if (watchSettled || !watchAnswered) stop()
        else void watchAnswered.then(stop)
      }
    }
  }, [connected, controls, historyRows, holderRefreshMs, readOnly, restartKey, sessionId, terminalId])

  if (!sessionId) {
    return (
      <Empty className="min-h-full border-0 text-muted-foreground">
        <EmptyHeader>
          <EmptyMedia variant="icon"><TerminalSquareIcon /></EmptyMedia>
          <EmptyTitle>No active session</EmptyTitle>
          <EmptyDescription>Open a session before starting its terminal.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (readOnly && !watching) {
    return (
      <Empty className="min-h-full border-0 text-muted-foreground">
        <EmptyHeader>
          <EmptyMedia variant="icon"><TerminalSquareIcon /></EmptyMedia>
          <EmptyTitle>Watching only</EmptyTitle>
          <EmptyDescription>Terminal controls are unavailable. Session output remains readable in the thread.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  // A released shell still names its last holder, so the name alone is not the claim.
  const writable = !readOnly && claimHeld && metadata?.owner.clientId === controls.clientId
  const terminalStatus: TerminalStatus = closed ? "closed"
    : !connected ? "disconnected"
      : metadata ? "connected"
        : missing ? "no shell"
          : error ? "unavailable"
            : "connecting"
  // One selection drives the header's primary button and the reason shown
  // while it is inert, so the reason names the control that is actually there.
  // Taking the shell lives in the claim banner, not here.
  const primaryAction = closed || error ? "restart" : "interrupt"
  const claimable = metadata !== undefined && !writable && !closed
  const sendInterrupt = () => {
    if (!terminalId || !writable) return
    void controls.write(terminalId, "\x03").catch((cause: unknown) => {
      setError(failure(cause, "Terminal interrupt failed"))
    })
  }
  const sendInput = (data: string) => {
    const terminal = xtermRef.current
    if (!terminalId || !terminal || !writable) return
    void settleTerminalWrite(
      controls.write(terminalId, data),
      terminal,
      () => xtermRef.current,
      () => terminal.focus(),
      (cause: unknown) => {
        setError(failure(cause, "Terminal input failed"))
      },
    )
  }
  const close = () => {
    if (!terminalId || !writable) return
    void controls.close(terminalId).catch((cause: unknown) => {
      setError(failure(cause, "Terminal could not close"))
    })
  }
  const restart = () => {
    setError("")
    setRestartKey((current) => current + 1)
  }
  const claim = () => {
    if (!terminalId || readOnly) return
    const generation = generationRef.current
    void controls.claim(terminalId).then(
      (ownership) => {
        if (generationRef.current === generation) applyOwnershipRef.current?.(ownership)
      },
      (cause: unknown) => {
        if (generationRef.current === generation) setError(failure(cause, "Terminal takeover failed"))
      },
    )
  }
  const releaseShell = controls.release
  const release = () => {
    if (!terminalId || !writable || !releaseShell || releasing) return
    const generation = generationRef.current
    setReleasing(true)
    void releaseShell(terminalId).then(
      (ownership) => {
        if (generationRef.current !== generation) return
        setReleasing(false)
        applyOwnershipRef.current?.(ownership)
      },
      (cause: unknown) => {
        if (generationRef.current !== generation) return
        setReleasing(false)
        setError(failure(cause, "Terminal release failed"))
      },
    )
  }
  const attachOutput = async () => {
    const terminal = xtermRef.current
    if (!terminal) return
    // xterm parses writes later. An empty write's callback runs once every
    // write queued before it is in the buffer, so the file holds what was
    // printed up to the click rather than an older screen.
    await new Promise<void>((resolve) => terminal.write("", resolve))
    // A disconnect or session switch while waiting disposed this renderer.
    if (xtermRef.current !== terminal) return
    const { content, marked } = terminalAttachmentText(
      terminal.buffer.active,
      { historyFilled: historyFilledRef.current, earlierDropped, recordFull },
    )
    if (!content) {
      setAttachNote({ tone: "refused", text: "Nothing has been printed yet." })
      return
    }
    const outcome = composer.offer(sessionId, terminalOutputAttachment(content))
    const attached = "Attached to the composer as terminal-output.txt."
    setAttachNote(
      outcome === "attached"
        ? {
            tone: "done",
            text: marked === "cut"
              ? `${attached} The start was cut to fit the attachment limit.`
              : marked === "history" ? `${attached} The pane's history filled up, so earlier output may be missing.` : attached,
          }
        : outcome === "full"
          ? { tone: "refused", text: "The composer already holds the most attachments. Remove one to attach this output." }
          : { tone: "refused", text: "The composer for this session is not open." },
    )
  }

  const holder = metadata?.owner
  // Desktop V2 draws "Claimed by iPhone 16 Pro since 14:04". The time is the
  // daemon's claim time; an older daemon sends none, and the line ends at
  // the holder. A release keeps the time, so it is read only while held.
  const since = holder?.claimedAt === undefined ? "" : ` since ${readingTime(holder.claimedAt)}`
  const claimText = writable
    ? "You hold this shell"
    : !claimHeld
      ? "Nobody holds this shell"
      : `Claimed by ${holder?.device?.label ?? (holder ? clientNoun[holder.client] : "another device")}${since}`
  const claimNote = writable
    ? "One claimant at a time. Other devices can watch."
    : readOnly
      ? "This view reads the shell and cannot take it."
      : "Reading is free, typing needs the claim."
  // Q340 A: the design's footer reads "read-only, the agent owns this shell".
  // Here the shell is an interactive PTY a person opened, so the footer says
  // who can type in it instead. A closed shell holds no claim, so nobody can.
  // Offline, the daemon has released this connection's claim and may have
  // handed or closed the shell since, so the footer says that is not known.
  const footerNote = closed
    ? "closed, the shell has exited"
    : !connected
      ? "not connected, who holds the shell is not known"
      : readOnly
        ? "read-only, this device watches"
        : writable
          ? "interactive, this device holds the shell"
          : "read-only until you take the shell"

  return (
    <div className="flex h-full min-h-0 flex-col bg-code">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-sidebar px-3">
        {/* The dot used to be a raw span, aria-hidden, beside a line only a
            screen reader read. So a sighted reader told connected from
            disconnected by colour alone, which is the one thing StatusDot
            exists to prevent. The status is a word now, and the atom carries
            it. */}
        <StatusDot
          meaning={terminalStatusMeaning[terminalStatus]}
          label={terminalStatus}
          size="inline"
          className="shrink-0"
        />
        <span role="status" className="sr-only">Terminal status: {terminalStatus}. </span>
        <span className="min-w-0 truncate font-machine text-[10px] text-muted-foreground">
          {/* "connecting" was the fallback for an unknown shell, which said the
              wrong thing while disconnected: a pane that is not connected is not
              on its way to being. */}
          pty · {machineName} · {metadata?.shell ?? (terminalStatus === "connecting" ? "connecting" : "shell unknown")} · {metadata?.cwd ?? "session worktree"}
        </span>
        {/* A watcher can neither interrupt, restart nor close a shell, so the
            controls that could only ever be inert are not drawn. */}
        {!readOnly ? (
          <div className="ml-auto flex items-center gap-1">
            {primaryAction === "restart" ? (
              <Button variant="outline" size="xs" disabled={!connected} onClick={restart}>
                <TerminalSquareIcon data-icon="inline-start" />Restart
              </Button>
            ) : (
              <Button variant="outline" size="xs" disabled={!connected || !writable} onClick={sendInterrupt}>
                <CircleStopIcon data-icon="inline-start" />Interrupt ⌃C
              </Button>
            )}
            <Button variant="ghost" size="icon-xs" aria-label="Close terminal" disabled={closed || !connected || !writable} onClick={close}>
              <XIcon />
            </Button>
          </div>
        ) : closed || error ? (
          // A watched shell that exited is a closed record, and a refused
          // watch may be transient. Either way the holder's shell is read
          // again only by watching again.
          <div className="ml-auto flex items-center gap-1">
            <Button variant="outline" size="xs" disabled={!connected} onClick={restart}>Check again</Button>
          </div>
        ) : null}
      </div>
      {metadata && !closed && connected ? (
        <div
          className={`flex shrink-0 items-center gap-2.5 border-b px-3.5 py-2.5 ${writable ? "bg-ok-background" : "bg-info-background"}`}
        >
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${writable ? "bg-success" : "bg-info"}`} />
          {/* A status region, so a change of holder is announced and not only
              redrawn: it decides whether typing here reaches the shell. */}
          <div role="status" className="min-w-0 flex-1">
            <p className={`text-xs ${writable ? "text-ok-foreground" : "text-info-foreground"}`}>{claimText}</p>
            <p className={`text-[11px] leading-snug ${writable ? "text-ok-dim" : "text-info-dim"}`}>{claimNote}</p>
          </div>
          {claimable ? (
            <Button
              variant="outline"
              size="xs"
              className="shrink-0 border-info-border text-info-foreground"
              disabled={readOnly || !connected}
              onClick={claim}
            >
              Take the shell
            </Button>
          ) : writable && releaseShell ? (
            <Button
              variant="outline"
              size="xs"
              className="shrink-0 border-ok-border text-ok-foreground"
              disabled={releasing}
              onClick={release}
            >
              Release the shell
            </Button>
          ) : null}
        </div>
      ) : null}
      {/* The controls above go inert on disconnect, Restart included once the
          process has exited. A disabled control with no reason reads as broken
          rather than unavailable, so the reason is on screen beside them. */}
      {!connected ? (
        <p className="border-b bg-sidebar px-3 py-1.5 text-[11px] text-muted-foreground">
          {readOnly
            ? "Reconnect to the execution machine to read this shell."
            : primaryAction === "restart"
              ? "Reconnect to the execution machine to restart this terminal."
              : claimable
                ? "Reconnect to the execution machine to take the shell or close this terminal."
                : "Reconnect to the execution machine to interrupt or close this terminal."}
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive" className="m-3 w-auto" aria-live="polite">
          <CircleStopIcon />
          <AlertTitle>Terminal unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {/* Outside the stream, so a screen clear or a long scrollback cannot
          take the note away while the record is still partial. */}
      {earlierDropped ? (
        <p className="border-b bg-sidebar px-3 py-1.5 text-[11px] text-muted-foreground">
          Earlier output was not kept. The daemon's record of this shell starts after it.
        </p>
      ) : recordFull ? (
        <p className="border-b bg-sidebar px-3 py-1.5 text-[11px] text-muted-foreground">
          The daemon's record of this shell is full, so earlier output may not have been kept.
        </p>
      ) : null}
      {missing ? (
        <Empty className="min-h-0 flex-1 border-0 text-muted-foreground">
          <EmptyHeader>
            <EmptyMedia variant="icon"><TerminalSquareIcon /></EmptyMedia>
            <EmptyTitle>No shell is open in this session</EmptyTitle>
            {/* Read-only covers a watching device and an archived session, and
                only the first will ever see a shell open, so the line promises
                neither. */}
            <EmptyDescription>This view reads a shell. It cannot open one.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="xs" disabled={!connected} onClick={restart}>Check again</Button>
          </EmptyContent>
        </Empty>
      ) : null}
      {/* The stream stays mounted while the empty state shows, so Check again
          finds the element it reads into. */}
      <div ref={containerRef} hidden={missing} className="min-h-0 flex-1 p-3" />
      {!readOnly ? (
        <div
          className="hidden shrink-0 items-center gap-2 overflow-x-auto border-t bg-sidebar px-3 py-2 [@media(any-pointer:coarse)]:flex"
          aria-label="Terminal quick keys"
          role="toolbar"
        >
          {terminalQuickKeys.map((key) => (
            <Button
              key={key.ariaLabel}
              type="button"
              variant="outline"
              className="h-11 min-w-11 shrink-0 touch-manipulation px-3 font-machine text-[11px]"
              aria-label={key.ariaLabel}
              disabled={!connected || closed || !metadata || !writable}
              onClick={() => sendInput(terminalQuickKeyData(
                key,
                xtermRef.current?.modes.applicationCursorKeysMode ?? false,
              ))}
            >
              {key.label}
            </Button>
          ))}
        </div>
      ) : null}
      {metadata ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-sidebar px-3 py-2.5">
          {/* Shown only while this session's composer is open to receive it
              and a renderer holds output to read, so the button never hands
              output to a draft that is not there or reads from nothing. */}
          {canAttach && rendered ? (
            <Button variant="secondary" size="xs" onClick={() => void attachOutput()}>
              Attach this output to the composer
            </Button>
          ) : null}
          {attachNote ? (
            <span role="status" className={`text-[11px] ${attachNote.tone === "done" ? "text-muted-foreground" : "text-destructive"}`}>
              {attachNote.text}
            </span>
          ) : null}
          <span className="ml-auto font-machine text-[10.5px] text-faint">{footerNote}</span>
        </div>
      ) : null}
    </div>
  )
}
