import { useCallback, useEffect, useRef, useState } from "react"

import type { ClientKind, Runtime, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { DomovoiClient, getDemoWorkspace } from "./client"

export function useWorkspace(url: string, kind: ClientKind) {
  const clientRef = useRef<DomovoiClient | null>(null)
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(getDemoWorkspace)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let active = true
    const client = new DomovoiClient(url, kind)
    clientRef.current = client
    const onSnapshot = (event: Event) => {
      if (active) setSnapshot((event as CustomEvent<WorkspaceSnapshot>).detail)
    }
    const onDisconnected = () => {
      if (active) setConnected(false)
    }
    client.addEventListener("snapshot", onSnapshot)
    client.addEventListener("disconnected", onDisconnected)
    client.connect().then(
      (next) => {
        if (!active) return
        setSnapshot(next)
        setConnected(true)
      },
      () => {
        if (active) setConnected(false)
      },
    )

    return () => {
      active = false
      client.removeEventListener("snapshot", onSnapshot)
      client.removeEventListener("disconnected", onDisconnected)
      client.disconnect()
      clientRef.current = null
    }
  }, [kind, url])

  const resolveApproval = useCallback(
    async (
      approvalId: string,
      decision: "allow-once" | "always-project" | "deny" | "deny-explain",
      explanation?: string,
    ) => {
      const next = await clientRef.current?.resolveApproval(approvalId, decision, explanation)
      if (next) setSnapshot(next)
    },
    [],
  )

  const setRuntime = useCallback(async (sessionId: string, runtime: Runtime) => {
    const next = await clientRef.current?.setRuntime(sessionId, runtime)
    if (next) setSnapshot(next)
  }, [])

  return { connected, resolveApproval, setRuntime, snapshot }
}
