import { useCallback, useEffect, useRef, useState } from "react"

import type { Annotation, ApprovalDecision, ArtifactAccess, AuditExportParams, AuditExportResult, AuditQueryPage, AuditQueryParams, ClientKind, ProviderModel, RpcParams, Runtime, SessionEvidence, SessionHistoryPage, SkillDocument, SkillInventory, SkillSummary, SystemEmergencyStopResult, TerminalClosedNotification, TerminalOutputNotification, TerminalOwnershipNotification, TerminalSession, WorkspaceDelta, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { DomovoiClient, type DomovoiRequestOptions } from "./client"
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

export function applyEmergencyStopResult<T>(
  currentClient: T | null,
  candidateClient: T,
  state: WorkspaceSnapshotState,
  target: string,
  result: SystemEmergencyStopResult,
): WorkspaceSnapshotState {
  return applyConnectionSnapshot(currentClient, candidateClient, state, target, result.snapshot)
}

export function claimEmergencyStop<T>(
  pending: { current: T | null },
  client: T,
): boolean {
  if (pending.current) return false
  pending.current = client
  return true
}

export function useWorkspace(url: string, kind: ClientKind, authToken?: string) {
  const target = `${kind}:${url}`
  const clientRef = useRef<DomovoiClient | null>(null)
  const emergencyStopClientRef = useRef<DomovoiClient | null>(null)
  const clientIdRef = useRef(crypto.randomUUID())
  const [workspace, setWorkspace] = useState<WorkspaceSnapshotState>(() => ({
    target,
    snapshot: null,
  }))
  const [connected, setConnected] = useState(false)
  const [emergencyStopPending, setEmergencyStopPending] = useState(false)
  const [emergencyStopOutcome, setEmergencyStopOutcome] = useState<SystemEmergencyStopResult | null>(null)
  const [emergencyStopError, setEmergencyStopError] = useState<string | null>(null)
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
    emergencyStopClientRef.current = null
    setEmergencyStopPending(false)
    setEmergencyStopOutcome(null)
    setEmergencyStopError(null)
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
    const onEmergencyStopped = (event: Event) => {
      if (!active) return
      const result = (event as CustomEvent<SystemEmergencyStopResult>).detail
      setWorkspace((current) => applyEmergencyStopResult(
        clientRef.current,
        client,
        current,
        target,
        result,
      ))
      setEmergencyStopOutcome(result)
      setEmergencyStopError(null)
    }
    const onDisconnected = () => {
      if (active) setConnected(false)
    }
    const onConnected = () => {
      if (active) setConnected(true)
    }
    client.addEventListener("snapshot", onSnapshot)
    client.addEventListener("workspace-delta", onDelta)
    client.addEventListener("emergency-stopped", onEmergencyStopped)
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
      client.removeEventListener("emergency-stopped", onEmergencyStopped)
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

  const restartProviderThread = useCallback(async (sessionId: string, runtime?: Runtime) => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    updateSnapshotFrom(client, await client.restartProviderThread(sessionId, runtime))
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

  const emergencyStop = useCallback(async (): Promise<void> => {
    const client = clientRef.current
    if (!client) {
      setEmergencyStopError("Daemon connection is not open")
      return
    }
    if (!claimEmergencyStop(emergencyStopClientRef, client)) return

    setEmergencyStopPending(true)
    setEmergencyStopOutcome(null)
    setEmergencyStopError(null)
    try {
      const result = await client.emergencyStop()
      if (!isCurrentConnection(clientRef.current, client)) return
      setWorkspace((current) => applyEmergencyStopResult(
        clientRef.current,
        client,
        current,
        target,
        result,
      ))
      setEmergencyStopOutcome(result)
    } catch (cause) {
      if (isCurrentConnection(clientRef.current, client)) {
        setEmergencyStopError(
          cause instanceof Error ? cause.message : "Active work could not be stopped",
        )
      }
    } finally {
      if (emergencyStopClientRef.current === client) {
        emergencyStopClientRef.current = null
        if (isCurrentConnection(clientRef.current, client)) setEmergencyStopPending(false)
      }
    }
  }, [target])

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

  const refreshProviders = useCallback(async (): Promise<WorkspaceSnapshot> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    const next = await client.refreshProviders()
    updateSnapshotFrom(client, next)
    return next
  }, [updateSnapshotFrom])

  const listSkills = useCallback(async (): Promise<SkillSummary[]> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.listSkills()
  }, [])

  const getSkillInventory = useCallback(async (): Promise<SkillInventory> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.getSkillInventory()
  }, [])

  const listProviderSecrets = useCallback(async () => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.listProviderSecrets()
  }, [])

  const readSkill = useCallback(async (id: string): Promise<SkillDocument> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.readSkill(id)
  }, [])

  const setSkillEnabled = useCallback(async (
    params: RpcParams<"skill.setEnabled">,
  ): Promise<WorkspaceSnapshot> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    const next = await client.setSkillEnabled(params)
    updateSnapshotFrom(client, next)
    return next
  }, [updateSnapshotFrom])

  const queryAudit = useCallback(async (
    params: AuditQueryParams,
    options?: DomovoiRequestOptions,
  ): Promise<AuditQueryPage> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.queryAudit(params, options)
  }, [])

  const exportAudit = useCallback(async (
    params: AuditExportParams,
    options?: DomovoiRequestOptions,
  ): Promise<AuditExportResult> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.exportAudit(params, options)
  }, [])

  const authorizeArtifact = useCallback(async (
    input: {
      sessionId: string
      artifactId: string
      revision: number
      purpose: ArtifactAccess["purpose"]
      bridgeChannel?: string
    },
  ): Promise<ArtifactAccess> => {
    const client = clientRef.current
    if (!client) throw new Error("Daemon connection is not open")
    return client.authorizeArtifact(input)
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
    visualContextUpload?: RpcParams<"annotation.create">["visualContextUpload"]
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
    emergencyStop,
    emergencyStopError,
    emergencyStopOutcome,
    emergencyStopPending,
    exportAudit,
    forkSession,
    getSkillInventory,
    listSkills,
    loadSessionHistory,
    loadSessionEvidence,
    listModels,
    listProviderSecrets,
    openProject,
    pauseAll,
    pauseSession,
    queryAudit,
    readSkill,
    refreshProviders,
    reconnect,
    restoreCheckpoint,
    restartProviderThread,
    resizeTerminal,
    replyToAnnotation,
    resolveApproval,
    sendMessage,
    setSkillEnabled,
    setAnnotationStatus,
    setRuntime,
    snapshot,
    subscribeTerminal,
    terminalClientId: clientIdRef.current,
    writeTerminal,
  }
}
