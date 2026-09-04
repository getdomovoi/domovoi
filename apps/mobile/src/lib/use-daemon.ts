import { useCallback, useEffect, useRef, useState } from "react"
import { applyWorkspaceDelta, type WorkspaceDelta, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { DaemonConnection, type DaemonStatus } from "./daemon"

export function useDaemon(url: string | undefined, token: string | undefined) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | undefined>(undefined)
  const [status, setStatus] = useState<DaemonStatus>("closed")
  const [problem, setProblem] = useState("")
  const connection = useRef<DaemonConnection | undefined>(undefined)

  useEffect(() => {
    if (!url || !token) return
    setProblem("")
    const daemon = new DaemonConnection(url, token, {
      onSnapshot: setSnapshot,
      onDelta: (delta: WorkspaceDelta) =>
        setSnapshot((current) => current ? applyWorkspaceDelta(current, delta) : current),
      onStatus: setStatus,
      onError: setProblem,
    })
    connection.current = daemon
    daemon.connect()
    return () => {
      daemon.close()
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
