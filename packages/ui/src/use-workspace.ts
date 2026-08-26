import { useCallback, useEffect, useRef, useState } from "react"

import type { ApprovalDecision, ClientKind, Runtime, WorkspaceSnapshot } from "@getdomovoi/protocol"

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
      decision: ApprovalDecision,
      explanation?: string,
    ) => {
      const client = clientRef.current
      if (!client) throw new Error("Daemon connection is not open")
      setSnapshot(await client.resolveApproval(approvalId, decision, explanation))
    },
    [],
  )

  const setRuntime = useCallback(async (sessionId: string, runtime: Runtime) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    setSnapshot(await client.setRuntime(sessionId, runtime))
  }, [])

  const openProject = useCallback(async (path: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    setSnapshot(await client.openProject(path))
  }, [])

  const createSession = useCallback(async (title: string, runtime: Runtime) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    setSnapshot(await client.createSession(title, runtime))
  }, [])

  const sendMessage = useCallback(async (sessionId: string, prompt: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    setSnapshot(await client.sendMessage(sessionId, prompt))
  }, [])

  const createCheckpoint = useCallback(async (sessionId: string, label?: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    setSnapshot(await client.createCheckpoint(sessionId, label))
  }, [])

  return {
    connected,
    createCheckpoint,
    createSession,
    openProject,
    resolveApproval,
    sendMessage,
    setRuntime,
    snapshot,
  }
}
