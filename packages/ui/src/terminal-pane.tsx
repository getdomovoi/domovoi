import { useEffect, useMemo, useRef, useState } from "react"
import { CircleStopIcon, TerminalSquareIcon, XIcon } from "lucide-react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

import type {
  TerminalClosedNotification,
  TerminalOutputNotification,
  TerminalSession,
} from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { terminalIdForSession } from "./terminal-id"

export type TerminalControls = {
  create(
    sessionId: string,
    dimensions: { cols: number; rows: number },
    terminalId: string,
  ): Promise<TerminalSession>
  write(terminalId: string, data: string): Promise<void>
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  close(terminalId: string): Promise<void>
  subscribe(
    terminalId: string,
    handlers: {
      output: (event: TerminalOutputNotification) => void
      closed: (event: TerminalClosedNotification) => void
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
    setMetadata(undefined)
    setError("")
    setClosed(false)
    const styles = getComputedStyle(container)
    const terminal = new Terminal({
      cursorBlink: true,
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
    fit.fit()
    const unsubscribe = controls.subscribe(terminalId, {
      output: ({ data }) => terminal.write(data),
      closed: ({ exitCode }) => {
        setClosed(true)
        terminal.write(`\r\n[process exited${exitCode === undefined ? "" : ` ${exitCode}`}]\r\n`)
      },
    })
    const input = terminal.onData((data) => {
      void controls.write(terminalId, data).catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Terminal input failed")
      })
    })
    const observer = new ResizeObserver(() => {
      fit.fit()
      if (!attached) return
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
        setMetadata(session)
        if (session.buffer) terminal.write(session.buffer)
        void controls.resize(terminalId, terminal.cols, terminal.rows).catch(() => undefined)
        terminal.focus()
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

  const sendInterrupt = () => {
    if (!terminalId) return
    void controls.write(terminalId, "\x03").catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Terminal interrupt failed")
    })
  }
  const close = () => {
    if (!terminalId) return
    void controls.close(terminalId).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Terminal could not close")
    })
  }
  const restart = () => {
    setError("")
    setRestartKey((current) => current + 1)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-code">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className={`size-1.5 rounded-full ${closed ? "bg-faint" : connected ? "bg-success" : "bg-warning"}`} />
        <span className="min-w-0 truncate font-machine text-[10px] text-muted-foreground">
          pty · {machineName} · {metadata?.shell ?? "connecting"} · {metadata?.cwd ?? "session worktree"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {closed || error ? (
            <Button variant="outline" size="xs" disabled={!connected} onClick={restart}>
              <TerminalSquareIcon data-icon="inline-start" />Restart
            </Button>
          ) : (
            <Button variant="outline" size="xs" disabled={!connected} onClick={sendInterrupt}>
              <CircleStopIcon data-icon="inline-start" />Interrupt ⌃C
            </Button>
          )}
          <Button variant="ghost" size="icon-xs" aria-label="Close terminal" disabled={closed || !connected} onClick={close}>
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
    </div>
  )
}
