import { useCallback, useEffect, useRef, useState } from "react"
import { AppState } from "react-native"
import {
  applyWorkspaceDelta,
  workspaceSnapshotSchema,
  type WorkspaceDelta,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { connectionFault, type ConnectionFault } from "./connection-fault"
import { DaemonConnection, type DaemonStatus } from "./daemon"
import { retryDelayMs } from "./reconnect"

export function useDaemon(url: string | undefined, token: string | undefined) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | undefined>(undefined)
  const [status, setStatus] = useState<DaemonStatus>("closed")
  const [fault, setFault] = useState<ConnectionFault | undefined>(undefined)
  const connection = useRef<DaemonConnection | undefined>(undefined)
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Set when the daemon has given an answer it will give again to every retry.
  // Nothing reopens the connection after that except the person changing the
  // credential, which re-runs this effect and clears it.
  const givenUp = useRef(false)

  useEffect(() => {
    if (!url || !token) {
      setStatus("closed")
      return
    }
    let live = true
    attempt.current = 0
    givenUp.current = false
    setFault(undefined)

    const open = () => {
      if (!live || givenUp.current) return
      const daemon = new DaemonConnection(url, token, {
        onSnapshot: (next) => {
          // A greeting that answers is the only proof the connection works, so
          // the backoff resets here rather than when the socket opens.
          attempt.current = 0
          setFault(undefined)
          setSnapshot(next)
        },
        onDelta: (delta: WorkspaceDelta) =>
          setSnapshot((current) => current ? applyWorkspaceDelta(current, delta) : current),
        onStatus: setStatus,
        onError: (cause) => {
          const next = connectionFault(cause)
          setFault(next)
          if (!next.retriable) givenUp.current = true
        },
        onClosed: () => {
          if (!live || givenUp.current) return
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
      if (givenUp.current) return
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

  // A client normally resyncs through the greeting on every reconnect, so this
  // exists for the one case that is not a reconnect: a person who wants to know
  // that what they are looking at is current, right now.
  const refresh = useCallback(async () => {
    const daemon = connection.current
    if (!daemon?.isOpen()) throw new Error("The daemon connection is not open")
    setSnapshot(workspaceSnapshotSchema.parse(await daemon.call("workspace.get", {})))
  }, [])

  return { snapshot, status, fault, call, refresh }
}
