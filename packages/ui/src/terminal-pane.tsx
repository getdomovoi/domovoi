import { useEffect, useMemo, useRef, useState } from "react"
import { CircleStopIcon, TerminalSquareIcon, XIcon } from "lucide-react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

import type {
  TerminalClosedNotification,
  TerminalOutputNotification,
  TerminalOwnershipNotification,
  TerminalSession,
} from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { StatusDot, type StatusMeaning } from "./status-dot"
import { terminalIdForSession } from "./terminal-id"
import { settleTerminalWrite } from "./terminal-input"
import { terminalQuickKeyData, terminalQuickKeys } from "./terminal-keys"

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

export function TerminalPane({
  connected,
  controls,
  machineName,
  sessionId,
}: {
  connected: boolean
  controls: TerminalControls
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
  const [error, setError] = useState("")
  const [closed, setClosed] = useState(false)
  const [restartKey, setRestartKey] = useState(0)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !connected || !sessionId || !terminalId) return
    let active = true
    let attached = false
    let ownsTerminal = false
    setMetadata(undefined)
    setError("")
    setClosed(false)
    const styles = getComputedStyle(container)
    const terminal = new Terminal({
      cursorBlink: true,
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
        ownsTerminal = owner.clientId === controls.clientId
        terminal.options.disableStdin = !ownsTerminal
        setMetadata((current) => current ? { ...current, owner } : current)
      },
    })
    const input = terminal.onData((data) => {
      if (!ownsTerminal) return
      void controls.write(terminalId, data).catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Terminal input failed")
      })
    })
    const observer = new ResizeObserver(() => {
      fit.fit()
      if (!attached || !ownsTerminal) return
      void controls.resize(terminalId, terminal.cols, terminal.rows).catch(() => undefined)
    })
    observer.observe(container)
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
    return () => {
      active = false
      unsubscribe()
      observer.disconnect()
      input.dispose()
      terminal.dispose()
      if (xtermRef.current === terminal) xtermRef.current = null
    }
  }, [connected, controls, restartKey, sessionId, terminalId])

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

  const writable = metadata?.owner.clientId === controls.clientId
  const terminalStatus = closed ? "closed" : connected ? metadata ? "connected" : "connecting" : "disconnected"
  // One selection drives the primary button and the reason shown while it is
  // inert, so the reason names the control that is actually there.
  const primaryAction = metadata && !writable && !closed ? "take-over" : closed || error ? "restart" : "interrupt"
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
    if (!terminalId) return
    void controls.claim(terminalId).then(
      ({ owner }) => setMetadata((current) => current ? { ...current, owner } : current),
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Terminal takeover failed")
      },
    )
  }

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
        <div className="ml-auto flex items-center gap-1">
          {primaryAction === "take-over" ? (
            <Button variant="outline" size="xs" disabled={!connected} onClick={claim}>
              Take over
            </Button>
          ) : primaryAction === "restart" ? (
            <Button variant="outline" size="xs" disabled={!connected} onClick={restart}>
              <TerminalSquareIcon data-icon="inline-start" />Restart
            </Button>
          ) : (
            <Button variant="outline" size="xs" disabled={!connected} onClick={sendInterrupt}>
              <CircleStopIcon data-icon="inline-start" />Interrupt ⌃C
            </Button>
          )}
          {metadata ? (
            <span className="hidden font-machine text-[10px] text-faint sm:inline">
              {metadata.owner.client}-owned
            </span>
          ) : null}
          <Button variant="ghost" size="icon-xs" aria-label="Close terminal" disabled={closed || !connected || !writable} onClick={close}>
            <XIcon />
          </Button>
        </div>
      </div>
      {/* The controls above go inert on disconnect, Restart included once the
          process has exited. A disabled control with no reason reads as broken
          rather than unavailable, so the reason is on screen beside them. */}
      {!connected ? (
        <p className="border-b bg-sidebar px-3 py-1.5 text-[11px] text-muted-foreground">
          {primaryAction === "restart"
            ? "Reconnect to the execution machine to restart this terminal."
            : primaryAction === "take-over"
              ? "Reconnect to the execution machine to take over or close this terminal."
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
      <div ref={containerRef} className="min-h-0 flex-1 p-3" />
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
    </div>
  )
}
