import { useCallback, useEffect, useRef, useState } from "react"

import type { Annotation, ApprovalDecision, ArtifactAccess, ClientKind, ProviderModel, RpcParams, Runtime, SessionEvidence, SessionHistoryPage, SkillDocument, SkillSummary, TerminalClosedNotification, TerminalOutputNotification, TerminalOwnershipNotification, TerminalSession, WorkspaceDelta, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { DomovoiClient } from "./client"
import { applyWorkspaceDelta } from "./workspace-delta"

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

export function applyConnectionSnapshot<T>(
  currentClient: T | null,
  candidateClient: T,
  state: WorkspaceSnapshotState,
  target: string,
  snapshot: WorkspaceSnapshot,
): WorkspaceSnapshotState {
  return isCurrentConnection(currentClient, candidateClient)
    ? applyWorkspaceSnapshot(state, target, snapshot)
    : state
}

export function useWorkspace(url: string, kind: ClientKind, authToken?: string) {
  const target = `${kind}:${url}`
  const clientRef = useRef<DomovoiClient | null>(null)
  const clientIdRef = useRef(crypto.randomUUID())
  const [workspace, setWorkspace] = useState<WorkspaceSnapshotState>(() => ({
    target,
    snapshot: null,
  }))
  const [connected, setConnected] = useState(false)
  const snapshot = visibleWorkspaceSnapshot(workspace, target)
  const updateSnapshotFrom = useCallback((client: DomovoiClient, next: WorkspaceSnapshot) => {
    setWorkspace((current) => applyConnectionSnapshot(
      clientRef.current,
      client,
      current,
      target,
      next,
    ))
  }, [target])
  const updateDeltaFrom = useCallback((client: DomovoiClient, delta: WorkspaceDelta) => {
    setWorkspace((current) => {
      if (!isCurrentConnection(clientRef.current, client) || current.target !== target) return current
      return current.snapshot
        ? { target, snapshot: applyWorkspaceDelta(current.snapshot, delta) }
        : current
    })
  }, [target])

  useEffect(() => {
    let active = true
    setConnected(false)
    setWorkspace({ target, snapshot: null })
    const client = new DomovoiClient(url, kind, {
      ...(authToken ? { authToken } : {}),
      clientId: clientIdRef.current,
    })
    clientRef.current = client
    const onSnapshot = (event: Event) => {
      if (active) updateSnapshotFrom(client, (event as CustomEvent<WorkspaceSnapshot>).detail)
    }
    const onDelta = (event: Event) => {
      if (active) updateDeltaFrom(client, (event as CustomEvent<WorkspaceDelta>).detail)
    }
    const onDisconnected = () => {
      if (active) setConnected(false)
    }
    const onConnected = () => {
      if (active) setConnected(true)
    }
    client.addEventListener("snapshot", onSnapshot)
    client.addEventListener("workspace-delta", onDelta)
    client.addEventListener("connected", onConnected)
    client.addEventListener("disconnected", onDisconnected)
    client.connect().then(
      (next) => {
        if (!active) return
        updateSnapshotFrom(client, next)
        setConnected(true)
      },
      () => {
        if (active) setConnected(false)
      },
    )

    return () => {
      active = false
      client.removeEventListener("snapshot", onSnapshot)
      client.removeEventListener("workspace-delta", onDelta)
      client.removeEventListener("connected", onConnected)
      client.removeEventListener("disconnected", onDisconnected)
      client.disconnect()
      clientRef.current = null
    }
  }, [authToken, kind, target, updateDeltaFrom, updateSnapshotFrom, url])

  const resolveApproval = useCallback(
    async (
      approvalId: string,
      decision: ApprovalDecision,
      explanation?: string,
    ) => {
      const client = clientRef.current
      if (!client) throw new Error("Daemon connection is not open")
      updateSnapshotFrom(client, await client.resolveApproval(approvalId, decision, explanation))
    },
    [updateSnapshotFrom],
  )

  const setRuntime = useCallback(async (sessionId: string, runtime: Runtime) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshotFrom(client, await client.setRuntime(sessionId, runtime))
  }, [updateSnapshotFrom])

  const activateSession = useCallback(async (sessionId: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshotFrom(client, await client.activateSession(sessionId))
  }, [updateSnapshotFrom])

  const openProject = useCallback(async (path: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshotFrom(client, await client.openProject(path))
  }, [updateSnapshotFrom])

  const createSession = useCallback(async (title: string, runtime: Runtime) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshotFrom(client, await client.createSession(title, runtime))
  }, [updateSnapshotFrom])

  const forkSession = useCallback(async (
    input: Omit<RpcParams<"session.fork">, "client">,
  ) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshotFrom(
      client,
      await client.forkSession(input),
    )
  }, [updateSnapshotFrom])

  const sendMessage = useCallback(async (sessionId: string, prompt: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshotFrom(client, await client.sendMessage(sessionId, prompt))
  }, [updateSnapshotFrom])

  const createCheckpoint = useCallback(async (sessionId: string, label?: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshotFrom(client, await client.createCheckpoint(sessionId, label))
  }, [updateSnapshotFrom])

  const restoreCheckpoint = useCallback(async (sessionId: string, checkpointId: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshotFrom(client, await client.restoreCheckpoint(sessionId, checkpointId))
  }, [updateSnapshotFrom])

  const pauseAll = useCallback(async () => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshotFrom(client, await client.pauseAll())
  }, [updateSnapshotFrom])

  const pauseSession = useCallback(async (sessionId: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshotFrom(client, await client.pauseSession(sessionId))
  }, [updateSnapshotFrom])

  const archiveSession = useCallback(async (sessionId: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshotFrom(client, await client.archiveSession(sessionId))
  }, [updateSnapshotFrom])

  const loadSessionHistory = useCallback(async (
    sessionId: string,
    options?: Omit<RpcParams<"session.history">, "sessionId">,
  ): Promise<SessionHistoryPage> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.loadSessionHistory(sessionId, options)
  }, [])

  const loadSessionEvidence = useCallback(async (sessionId: string): Promise<SessionEvidence> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.loadSessionEvidence(sessionId)
  }, [])

  const listModels = useCallback(async (provider: string): Promise<ProviderModel[]> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.listModels(provider)
  }, [])

  const listSkills = useCallback(async (): Promise<SkillSummary[]> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.listSkills()
  }, [])

  const readSkill = useCallback(async (id: string): Promise<SkillDocument> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.readSkill(id)
  }, [])

  const authorizeArtifact = useCallback(async (
    artifactId: string,
    bridgeChannel?: string,
  ): Promise<ArtifactAccess> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.authorizeArtifact(artifactId, bridgeChannel)
  }, [])

  const createTerminal = useCallback(async (
    sessionId: string,
    dimensions: { cols: number; rows: number },
    terminalId: string,
  ): Promise<TerminalSession> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.createTerminal(sessionId, dimensions, terminalId)
  }, [])

  const writeTerminal = useCallback(async (terminalId: string, data: string): Promise<void> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.writeTerminal(terminalId, data)
  }, [])

  const resizeTerminal = useCallback(async (
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<void> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.resizeTerminal(terminalId, cols, rows)
  }, [])

  const closeTerminal = useCallback(async (terminalId: string): Promise<void> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.closeTerminal(terminalId)
  }, [])

  const claimTerminal = useCallback(async (
    terminalId: string,
  ): Promise<TerminalOwnershipNotification> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.claimTerminal(terminalId)
  }, [])

  const subscribeTerminal = useCallback((
    terminalId: string,
    handlers: {
      output: (event: TerminalOutputNotification) => void
      closed: (event: TerminalClosedNotification) => void
      ownership: (event: TerminalOwnershipNotification) => void
    },
  ): (() => void) => {
    const client = clientRef.current
    if (!client) return () => {}
    const output = (event: Event) => {
      const detail = (event as CustomEvent<TerminalOutputNotification>).detail
      if (detail.terminalId === terminalId) handlers.output(detail)
    }
    const closed = (event: Event) => {
      const detail = (event as CustomEvent<TerminalClosedNotification>).detail
      if (detail.terminalId === terminalId) handlers.closed(detail)
    }
    const ownership = (event: Event) => {
      const detail = (event as CustomEvent<TerminalOwnershipNotification>).detail
      if (detail.terminalId === terminalId) handlers.ownership(detail)
    }
    client.addEventListener("terminal-output", output)
    client.addEventListener("terminal-closed", closed)
    client.addEventListener("terminal-ownership", ownership)
    return () => {
      client.removeEventListener("terminal-output", output)
      client.removeEventListener("terminal-closed", closed)
      client.removeEventListener("terminal-ownership", ownership)
    }
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
    updateSnapshotFrom(client, await client.createAnnotation(input))
  }, [updateSnapshotFrom])

  const replyToAnnotation = useCallback(async (annotationId: string, body: string) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshotFrom(client, await client.replyToAnnotation(annotationId, body))
  }, [updateSnapshotFrom])

  const setAnnotationStatus = useCallback(async (
    annotationId: string,
    status: Annotation["status"],
  ) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshotFrom(client, await client.setAnnotationStatus(annotationId, status))
  }, [updateSnapshotFrom])

  const reconnect = useCallback(async () => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon client is not ready")
    setConnected(false)
    const next = await client.connect()
    if (!isCurrentConnection(clientRef.current, client)) return
    updateSnapshotFrom(client, next)
    setConnected(true)
  }, [updateSnapshotFrom])

  return {
    activateSession,
    archiveSession,
    authorizeArtifact,
    claimTerminal,
    closeTerminal,
    connected,
    createCheckpoint,
    createAnnotation,
    createTerminal,
    createSession,
    forkSession,
    listSkills,
    loadSessionHistory,
    loadSessionEvidence,
    listModels,
    openProject,
    pauseAll,
    pauseSession,
    readSkill,
    reconnect,
    restoreCheckpoint,
    resizeTerminal,
    replyToAnnotation,
    resolveApproval,
    sendMessage,
    setAnnotationStatus,
    setRuntime,
    snapshot,
    subscribeTerminal,
    terminalClientId: clientIdRef.current,
    writeTerminal,
  }
}
