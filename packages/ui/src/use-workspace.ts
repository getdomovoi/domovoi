import { useCallback, useEffect, useRef, useState } from "react"

import type { Annotation, ApprovalDecision, ClientKind, ProviderModel, Runtime, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { DomovoiClient } from "./client"

type WorkspaceSnapshotState = {
  target: string
  snapshot: WorkspaceSnapshot | null
}

export function visibleWorkspaceSnapshot(
  state: WorkspaceSnapshotState,
  target: string,
): WorkspaceSnapshot | null {
  return state.target === target ? state.snapshot : null
}

export function applyWorkspaceSnapshot(
  state: WorkspaceSnapshotState,
  target: string,
  snapshot: WorkspaceSnapshot,
): WorkspaceSnapshotState {
  return state.target === target ? { target, snapshot } : state
}

export function isCurrentConnection<T>(current: T | null, candidate: T): boolean {
  return current === candidate
}

export function useWorkspace(url: string, kind: ClientKind) {
  const target = `${kind}:${url}`
  const clientRef = useRef<DomovoiClient | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceSnapshotState>(() => ({
    target,
    snapshot: null,
  }))
  const [connected, setConnected] = useState(false)
  const snapshot = visibleWorkspaceSnapshot(workspace, target)
  const updateSnapshot = useCallback((next: WorkspaceSnapshot) => {
    setWorkspace((current) => applyWorkspaceSnapshot(current, target, next))
  }, [target])

  useEffect(() => {
    let active = true
    setConnected(false)
    setWorkspace({ target, snapshot: null })
    const client = new DomovoiClient(url, kind)
    clientRef.current = client
    const onSnapshot = (event: Event) => {
      if (active) updateSnapshot((event as CustomEvent<WorkspaceSnapshot>).detail)
    }
    const onDisconnected = () => {
      if (active) setConnected(false)
    }
    const onConnected = () => {
      if (active) setConnected(true)
    }
    client.addEventListener("snapshot", onSnapshot)
    client.addEventListener("connected", onConnected)
    client.addEventListener("disconnected", onDisconnected)
    client.connect().then(
      (next) => {
        if (!active) return
        updateSnapshot(next)
        setConnected(true)
      },
      () => {
        if (active) setConnected(false)
      },
    )

    return () => {
      active = false
      client.removeEventListener("snapshot", onSnapshot)
      client.removeEventListener("connected", onConnected)
      client.removeEventListener("disconnected", onDisconnected)
      client.disconnect()
      clientRef.current = null
    }
  }, [kind, target, updateSnapshot, url])

  const resolveApproval = useCallback(
    async (
      approvalId: string,
      decision: ApprovalDecision,
      explanation?: string,
    ) => {
      const client = clientRef.current
      if (!client) throw new Error("Daemon connection is not open")
      updateSnapshot(await client.resolveApproval(approvalId, decision, explanation))
    },
    [updateSnapshot],
  )

  const setRuntime = useCallback(async (sessionId: string, runtime: Runtime) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshot(await client.setRuntime(sessionId, runtime))
  }, [updateSnapshot])

  const activateSession = useCallback(async (sessionId: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshot(await client.activateSession(sessionId))
  }, [updateSnapshot])

  const openProject = useCallback(async (path: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshot(await client.openProject(path))
  }, [updateSnapshot])

  const createSession = useCallback(async (title: string, runtime: Runtime) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshot(await client.createSession(title, runtime))
  }, [updateSnapshot])

  const sendMessage = useCallback(async (sessionId: string, prompt: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshot(await client.sendMessage(sessionId, prompt))
  }, [updateSnapshot])

  const createCheckpoint = useCallback(async (sessionId: string, label?: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshot(await client.createCheckpoint(sessionId, label))
  }, [updateSnapshot])

  const pauseAll = useCallback(async () => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshot(await client.pauseAll())
  }, [updateSnapshot])

  const listModels = useCallback(async (provider: "codex"): Promise<ProviderModel[]> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.listModels(provider)
  }, [])

  const createAnnotation = useCallback(async (input: {
    sessionId: string
    artifactId: string
    variantId?: string
    anchor: Annotation["anchor"]
    body: string
  }) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshot(await client.createAnnotation(input))
  }, [updateSnapshot])

  const replyToAnnotation = useCallback(async (annotationId: string, body: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshot(await client.replyToAnnotation(annotationId, body))
  }, [updateSnapshot])

  const setAnnotationStatus = useCallback(async (
    annotationId: string,
    status: Annotation["status"],
  ) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshot(await client.setAnnotationStatus(annotationId, status))
  }, [updateSnapshot])

  const reconnect = useCallback(async () => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon client is not ready")
    setConnected(false)
    const next = await client.connect()
    if (!isCurrentConnection(clientRef.current, client)) return
    updateSnapshot(next)
    setConnected(true)
  }, [updateSnapshot])

  return {
    activateSession,
    connected,
    createCheckpoint,
    createAnnotation,
    createSession,
    listModels,
    openProject,
    pauseAll,
    reconnect,
    replyToAnnotation,
    resolveApproval,
    sendMessage,
    setAnnotationStatus,
    setRuntime,
    snapshot,
  }
}
