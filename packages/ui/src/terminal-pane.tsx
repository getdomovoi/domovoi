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
      lineHeight: 1.55,
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
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span aria-hidden="true" data-status-dot="" className={`size-1.5 rounded-full ${closed ? "bg-faint" : connected ? "bg-success" : "bg-warning"}`} />
        <span role="status" className="sr-only">Terminal status: {terminalStatus}. </span>
        <span className="min-w-0 truncate font-machine text-[10px] text-muted-foreground">
          pty · {machineName} · {metadata?.shell ?? "connecting"} · {metadata?.cwd ?? "session worktree"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {metadata && !writable && !closed ? (
            <Button variant="outline" size="xs" disabled={!connected} onClick={claim}>
              Take over
            </Button>
          ) : closed || error ? (
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
      {error ? (
        <Alert variant="destructive" className="m-3 w-auto" aria-live="polite">
          <CircleStopIcon />
          <AlertTitle>Terminal unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div ref={containerRef} className="min-h-0 flex-1 p-3" />
      <div
        className="hidden shrink-0 items-center gap-2 overflow-x-auto border-t px-3 py-2 [@media(any-pointer:coarse)]:flex"
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
