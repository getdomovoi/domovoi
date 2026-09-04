import { useCallback, useEffect, useRef, useState } from "react"
import { AppState } from "react-native"
import { applyWorkspaceDelta, type WorkspaceDelta, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { DaemonConnection, type DaemonStatus } from "./daemon"
import { retryDelayMs } from "./reconnect"

export type DaemonState = {
  snapshot: WorkspaceSnapshot | undefined
  status: DaemonStatus
  problem: string
  retryingInMs: number | undefined
}

export function useDaemon(url: string | undefined, token: string | undefined) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | undefined>(undefined)
  const [status, setStatus] = useState<DaemonStatus>("closed")
  const [problem, setProblem] = useState("")
  const connection = useRef<DaemonConnection | undefined>(undefined)
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!url || !token) {
      setStatus("closed")
      return
    }
    let live = true
    attempt.current = 0

    const open = () => {
      if (!live) return
      const daemon = new DaemonConnection(url, token, {
        onSnapshot: (next) => {
          // A greeting that answers is the only proof the connection works, so
          // the backoff resets here rather than when the socket opens.
          attempt.current = 0
          setProblem("")
          setSnapshot(next)
        },
        onDelta: (delta: WorkspaceDelta) =>
          setSnapshot((current) => current ? applyWorkspaceDelta(current, delta) : current),
        onStatus: setStatus,
        onError: setProblem,
        onClosed: () => {
          if (!live) return
          attempt.current += 1
          timer.current = setTimeout(open, retryDelayMs(attempt.current))
        },
      })
      connection.current = daemon
      daemon.connect()
    }

    open()

    // Coming back from the background is the most common moment for a phone to
    // find its connection dead, and waiting out the backoff there would leave
    // the person staring at a stale screen.
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") return
      if (connection.current?.isOpen()) return
      if (timer.current) clearTimeout(timer.current)
      attempt.current = 0
      open()
    })

    return () => {
      live = false
      subscription.remove()
      if (timer.current) clearTimeout(timer.current)
      connection.current?.close()
      connection.current = undefined
    }
  }, [token, url])

  const call = useCallback((method: string, params: unknown) => {
    const daemon = connection.current
    if (!daemon) return Promise.reject(new Error("The daemon connection is not open"))
    return daemon.call(method, params)
  }, [])

  return { snapshot, status, problem, call }
}
