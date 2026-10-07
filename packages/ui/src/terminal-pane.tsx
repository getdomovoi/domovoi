import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { CircleStopIcon, TerminalSquareIcon, XIcon } from "lucide-react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

import type {
  TerminalClosedNotification,
  TerminalOutputNotification,
  TerminalOwner,
  TerminalOwnershipNotification,
  TerminalSession,
  TerminalWatchResult,
} from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { composerInbox, type ComposerInbox } from "./composer-inbox"
import { terminalOutputAttachment } from "./desktop-attachments"
import { StatusDot, type StatusMeaning } from "./status-dot"
import { terminalIdForSession } from "./terminal-id"
import { settleTerminalWrite } from "./terminal-input"
import { terminalQuickKeyData, terminalQuickKeys } from "./terminal-keys"
import { terminalBufferText } from "./terminal-output-text"

export type TerminalControls = {
  clientId: string
  create(
    sessionId: string,
    dimensions: { cols: number; rows: number },
    terminalId: string,
  ): Promise<TerminalSession>
  claim(terminalId: string): Promise<TerminalOwnershipNotification>
  write(terminalId: string, data: string): Promise<void>
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  close(terminalId: string): Promise<void>
  subscribe(
    terminalId: string,
    handlers: {
      output: (event: TerminalOutputNotification) => void
      closed: (event: TerminalClosedNotification) => void
      ownership: (event: TerminalOwnershipNotification) => void
    },
  ): () => void
  // Reading without holding: terminal.watch and terminal.unwatch. A client
  // that cannot watch leaves them out, and a read-only pane then shows its
  // empty state rather than a stream it cannot fill.
  watch?(terminalId: string): Promise<TerminalWatchResult>
  unwatch?(terminalId: string): Promise<void>
}

// Four states the pane can be in, each with the atom's meaning for it. Keyed on
// the union the status is computed from, so a fifth state fails typecheck rather
// than rendering no dot.
const terminalStatusMeaning: Record<"closed" | "connected" | "connecting" | "disconnected", StatusMeaning> = {
  closed: "idle",
  connected: "online",
  connecting: "waiting",
  disconnected: "offline",
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

type AttachNote = { tone: "done" | "refused", text: string }

export function TerminalPane({
  composer = composerInbox,
  connected,
  controls,
  readOnly = false,
  machineName,
  sessionId,
}: {
  composer?: ComposerInbox
  connected: boolean
  controls: TerminalControls
  readOnly?: boolean
  machineName: string
  sessionId: string | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
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
  const watching = readOnly && controls.watch !== undefined
  const canAttach = useSyncExternalStore(
    composer.subscribe,
    () => composer.canReceive(sessionId),
    () => false,
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container || !connected || !sessionId || !terminalId) return
    const watch = controls.watch
    const unwatch = controls.unwatch
    if (readOnly && !watch) return
    let active = true
    let attached = false
    let ownsTerminal = false
    setMetadata(undefined)
    setClaimHeld(true)
    setMissing(false)
    setError("")
    setClosed(false)
    setAttachNote(undefined)
    const styles = getComputedStyle(container)
    const terminal = new Terminal({
      cursorBlink: !readOnly,
      disableStdin: true,
      fontFamily: "JetBrains Mono Variable, JetBrains Mono, monospace",
      fontSize: 11,
      lineHeight: 1.85,
      screenReaderMode: true,
      scrollback: 5_000,
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
    fit.fit()
    const unsubscribe = controls.subscribe(terminalId, {
      output: ({ data }) => terminal.write(data),
      closed: ({ exitCode }) => {
        setClosed(true)
        terminal.write(`\r\n[process exited${exitCode === undefined ? "" : ` ${exitCode}`}]\r\n`)
      },
      ownership: ({ owner }) => {
        // A watcher never holds the shell, whatever the notification says.
        const owned = ownsTerminal
        ownsTerminal = !readOnly && owner.clientId === controls.clientId
        terminal.options.disableStdin = !ownsTerminal
        // Taking the shell makes this pane's grid the shell's grid.
        if (ownsTerminal && !owned && attached) {
          fit.fit()
          void controls.resize(terminalId, terminal.cols, terminal.rows).catch(() => undefined)
        }
        setClaimHeld(true)
        setMetadata((current) => current ? { ...current, owner } : current)
      },
    })
    const input = terminal.onData((data) => {
      if (!ownsTerminal) return
      void controls.write(terminalId, data).catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Terminal input failed")
      })
    })
    // The shell has one grid, the holder's. A pane that does not hold it draws
    // at that grid rather than its own width, or every cursor-positioned
    // character the shell prints lands in the wrong column.
    const observer = new ResizeObserver(() => {
      if (attached && !ownsTerminal) return
      fit.fit()
      if (!attached) return
      void controls.resize(terminalId, terminal.cols, terminal.rows).catch(() => undefined)
    })
    observer.observe(container)
    if (readOnly && watch) {
      // The watching desktop reads the shell the way the phone does: the
      // daemon's kept record, then what it prints from here on. Nothing it
      // does reaches the process, and it never opens a shell of its own.
      void watch(terminalId).then(
        (record) => {
          if (!active) return
          attached = true
          const { buffer, claimHeld: held, cols, cwd, owner, rows, shell, state } = record
          setMetadata({ terminalId, sessionId, cols, rows, shell, cwd, buffer, owner })
          setClaimHeld(held)
          terminal.resize(cols, rows)
          if (buffer) terminal.write(buffer)
          if (state === "closed") {
            setClosed(true)
            terminal.write(`\r\n[process exited${record.exitCode === undefined ? "" : ` ${record.exitCode}`}]\r\n`)
          }
        },
        (cause: unknown) => {
          if (!active) return
          const message = cause instanceof Error ? cause.message : "Terminal could not be read"
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
          if (!ownsTerminal) terminal.resize(session.cols, session.rows)
          if (session.buffer) terminal.write(session.buffer)
          if (ownsTerminal) {
            void controls.resize(terminalId, terminal.cols, terminal.rows).catch(() => undefined)
            terminal.focus()
          }
        },
        (cause: unknown) => {
          if (active) setError(cause instanceof Error ? cause.message : "Terminal could not start")
        },
      )
    }
    return () => {
      active = false
      unsubscribe()
      observer.disconnect()
      input.dispose()
      terminal.dispose()
      if (xtermRef.current === terminal) xtermRef.current = null
      if (readOnly && unwatch) void unwatch(terminalId).catch(() => undefined)
    }
  }, [connected, controls, readOnly, restartKey, sessionId, terminalId])

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

  const writable = !readOnly && metadata?.owner.clientId === controls.clientId
  const terminalStatus = closed ? "closed" : connected ? metadata ? "connected" : "connecting" : "disconnected"
  // One selection drives the header's primary button and the reason shown
  // while it is inert, so the reason names the control that is actually there.
  // Taking the shell lives in the claim banner, not here.
  const primaryAction = closed || error ? "restart" : "interrupt"
  const claimable = metadata !== undefined && !writable && !closed
  const sendInterrupt = () => {
    if (!terminalId || !writable) return
    void controls.write(terminalId, "\x03").catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Terminal interrupt failed")
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
        setError(cause instanceof Error ? cause.message : "Terminal input failed")
      },
    )
  }
  const close = () => {
    if (!terminalId || !writable) return
    void controls.close(terminalId).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Terminal could not close")
    })
  }
  const restart = () => {
    setError("")
    setRestartKey((current) => current + 1)
  }
  const claim = () => {
    if (!terminalId || readOnly) return
    void controls.claim(terminalId).then(
      ({ owner }) => setMetadata((current) => current ? { ...current, owner } : current),
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Terminal takeover failed")
      },
    )
  }
  const attachOutput = () => {
    const terminal = xtermRef.current
    if (!terminal) return
    const text = terminalBufferText(terminal.buffer.active)
    if (!text) {
      setAttachNote({ tone: "refused", text: "Nothing has been printed yet." })
      return
    }
    const outcome = composer.offer(sessionId, terminalOutputAttachment(text))
    setAttachNote(
      outcome === "attached"
        ? { tone: "done", text: "Attached to the composer as terminal-output.txt." }
        : outcome === "full"
          ? { tone: "refused", text: "The composer already holds the most attachments. Remove one to attach this output." }
          : { tone: "refused", text: "The composer for this session is not open." },
    )
  }

  const holder = metadata?.owner
  const claimText = writable
    ? "You hold this shell"
    : !claimHeld
      ? "Nobody holds this shell"
      : `Claimed by ${holder?.device?.label ?? (holder ? clientNoun[holder.client] : "another device")}`
  const claimNote = writable
    ? "One claimant at a time. Other devices can watch."
    : readOnly
      ? "This view reads the shell and cannot take it."
      : "Reading is free, typing needs the claim."
  // Q340 A: the design's footer reads "read-only, the agent owns this shell".
  // Here the shell is an interactive PTY a person opened, so the footer says
  // who can type in it instead.
  const footerNote = readOnly
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
          pty · {machineName} · {metadata?.shell ?? (connected ? "connecting" : "shell unknown")} · {metadata?.cwd ?? "session worktree"}
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
        ) : closed ? (
          // A watched shell that exited is a closed record. Its holder may
          // open another, which this pane only reads by watching again.
          <div className="ml-auto flex items-center gap-1">
            <Button variant="outline" size="xs" disabled={!connected} onClick={restart}>Check again</Button>
          </div>
        ) : null}
      </div>
      {metadata && !closed ? (
        <div
          className={`flex shrink-0 items-center gap-2.5 border-b px-3.5 py-2.5 ${writable ? "bg-ok-background" : "bg-info-background"}`}
        >
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${writable ? "bg-success" : "bg-info"}`} />
          <div className="min-w-0 flex-1">
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
          ) : null}
        </div>
      ) : null}
      {/* The controls above go inert on disconnect, Restart included once the
          process has exited. A disabled control with no reason reads as broken
          rather than unavailable, so the reason is on screen beside them. */}
      {!connected && !readOnly ? (
        <p className="border-b bg-sidebar px-3 py-1.5 text-[11px] text-muted-foreground">
          {primaryAction === "restart"
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
          {/* Shown only while this session's composer is open to receive it,
              so the button never hands output to a draft that is not there. */}
          {canAttach ? (
            <Button variant="secondary" size="xs" onClick={attachOutput}>
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
