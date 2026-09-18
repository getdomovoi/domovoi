import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import {
  CircleStopIcon,
  CodeXmlIcon,
  FileDiffIcon,
  FileTextIcon,
  GitCommitHorizontalIcon,
  ShieldCheckIcon,
  HistoryIcon,
  DownloadIcon,
  MessageSquarePlusIcon,
  MessageSquareTextIcon,
  PanelRightCloseIcon,
  PrinterIcon,
  TerminalSquareIcon,
} from "lucide-react"
import type {
  Annotation,
  Artifact,
  ArtifactAccess,
  RpcParams,
  SessionEvidence,
  SessionHistoryPage,
  HardGateCategory,
  WorkspaceSnapshot,
  PreviewBridgePickerMessage,
  PreviewBridgeResolveAnchorsMessage,
  PreviewBridgeSelectionMessage,
} from "@getdomovoi/protocol"
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "./components/ui/field"
import { ScrollArea, ScrollBar } from "./components/ui/scroll-area"
import { Separator } from "./components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs"
import { Textarea } from "./components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip"
import { cn } from "./lib/utils"
import { artifactUrlFor } from "./artifact-url"
import { annotationsForActiveSession } from "./annotations"
import { annotationCaptureUpload } from "./annotation-capture"
import {
  anchorResolutionsFor,
  createPreviewBridgeChannel,
  mergeAnchorResolutionBatch,
  previewReadyFor,
  previewResolveAnchorMessages,
  previewSelectionFor,
} from "./preview-bridge"
import { latestArtifactForActiveSession, previewControlLayoutFor, previewStageGridColumns, previewStageObservationKey, previewStagesForReview, previewToolbarLayoutFor, previewVariantsForActiveSession, reviewLayoutFor } from "./artifacts"
import { PreviewThumbnailLifecycle, previewThumbnailObjectUrl, previewThumbnailRect } from "./preview-thumbnails"
import { WorkingPlanCard } from "./working-plan"
import { RulesPanel } from "./rules-panel.js"
import { CheckpointsPanel, latestCheckpointRevision } from "./checkpoints-panel.js"
import type { TerminalControls } from "./terminal-pane"
import { SessionEvidencePanel } from "./session-evidence"
import { MarkdownQuickView } from "./markdown-quick-view"
import { type DesktopWindowBridge } from "./desktop-platform"
import { HistoryPanel } from "./history-panel"
import { activeSession, sessionIsArchiveReadOnly } from "./workspace-selectors"

const TerminalPane = lazy(async () => {
  const module = await import("./terminal-pane")
  return { default: module.TerminalPane }
})
export function PreviewVariantThumbnail({ url }: { url?: string | undefined }) {
  const safeUrl = url?.startsWith("blob:") ? url : undefined
  return safeUrl
    ? <img className="aspect-video w-full rounded-sm border object-cover" src={safeUrl} alt="" />
    : <span aria-hidden="true" className="flex aspect-video w-full items-center justify-center rounded-sm border bg-muted" />
}

type ArtifactAuthorizationTarget = Pick<Artifact, "id" | "revision" | "sessionId">

export function artifactAuthorizationKey(targets: readonly ArtifactAuthorizationTarget[]): string {
  return JSON.stringify(targets.map(({ sessionId, id, revision }) => [sessionId, id, revision]))
}

// The key is this module's own JSON.stringify above, so an unreadable one is a
// bug here and not a damaged file; an entry that is not a triple is dropped.
function artifactAuthorizationTargets(key: string): ArtifactAuthorizationTarget[] {
  const parsed: unknown = JSON.parse(key)
  if (!Array.isArray(parsed)) return []
  const targets: ArtifactAuthorizationTarget[] = []
  for (const entry of parsed as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 3) continue
    const [sessionId, id, revision] = entry as unknown[]
    if (typeof sessionId !== "string" || typeof id !== "string" || typeof revision !== "number") continue
    targets.push({ sessionId, id, revision })
  }
  return targets
}

export async function capturePreviewThumbnailState({
  lifecycle,
  artifactId,
  revision,
  capture,
  sync,
}: {
  lifecycle: PreviewThumbnailLifecycle
  artifactId: string
  revision: number
  capture: () => Promise<Parameters<typeof previewThumbnailObjectUrl>[0]>
  sync: (ready: ReadonlyMap<string, string>) => void
}): Promise<void> {
  if (!lifecycle.reserve(artifactId, revision)) return
  sync(lifecycle.readyUrls())
  try {
    const url = previewThumbnailObjectUrl(await capture())
    if (!url) {
      lifecycle.fail(artifactId, revision)
      sync(lifecycle.readyUrls())
      return
    }
    lifecycle.resolve(artifactId, revision, url)
    sync(lifecycle.readyUrls())
  } catch {
    lifecycle.fail(artifactId, revision)
    sync(lifecycle.readyUrls())
  }
}
export function ArtifactDock({
  snapshot,
  onCollapse,
  collapseButtonRef,
  defaultTab,
  onEditPlan,
  onDiscardPlanEdit,
  tab,
  onTabChange,
  rpcUrl,
  authorizeArtifact,
  connected,
  terminalControls,
  onReplyToAnnotation,
  onSetAnnotationStatus,
  onCreateAnnotation,
  onLoadSessionHistory,
  onRestoreCheckpoint,
  worktreeName,
  onForkCheckpoint,
  onRevokeApprovalRule,
  onLoadHardGates,
  restoreBusy = false,
  onLoadSessionEvidence,
  onRevertSessionFile,
  captureAnnotation,
  previewRefusal,
}: {
  snapshot: WorkspaceSnapshot
  onCollapse: () => void
  collapseButtonRef?: RefObject<HTMLButtonElement | null>
  defaultTab: "changes" | "preview"
  previewRefusal?: string | undefined
  onEditPlan?: ((edit: {
    basedOnStructureRevision: number
    baseSteps: { id: string, text: string }[]
    draftSteps: { id?: string, text: string }[]
  }) => Promise<void>) | undefined
  onDiscardPlanEdit?: ((editId: string) => Promise<void>) | undefined
  tab?: string | undefined
  onTabChange?: ((tab: string) => void) | undefined
  rpcUrl: string
  authorizeArtifact: (input: {
    sessionId: string
    artifactId: string
    revision: number
    purpose: ArtifactAccess["purpose"]
    bridgeChannel?: string
    parentOrigin?: string
  }) => Promise<ArtifactAccess>
  connected: boolean
  terminalControls: TerminalControls
  onReplyToAnnotation: (annotationId: string, body: string) => Promise<void>
  onSetAnnotationStatus: (annotationId: string, status: Annotation["status"]) => Promise<void>
  onCreateAnnotation: (input: {
    sessionId: string
    artifactId: string
    anchor: Annotation["anchor"]
    body: string
    variantId?: string
    visualContextUpload?: {
      artifactRevision: number
      mimeType: "image/png"
      width: number
      height: number
      data: string
    }
  }) => Promise<void>
  captureAnnotation?: DesktopWindowBridge["captureAnnotation"]
  onLoadSessionHistory: (
    sessionId: string,
    options?: Omit<RpcParams<"session.history">, "sessionId">,
    requestOptions?: { signal?: AbortSignal },
  ) => Promise<SessionHistoryPage>
  onLoadSessionEvidence: (sessionId: string) => Promise<SessionEvidence>
  onRevertSessionFile: (sessionId: string, path: string, expectedBaseCommit?: string) => Promise<void>
  onRestoreCheckpoint?: ((checkpointId: string) => void) | undefined
  worktreeName?: string | undefined
  onForkCheckpoint?: ((checkpointId: string) => void) | undefined
  restoreBusy?: boolean
  // The Rules tab revokes through approvalRule.revoke and reads the daemon's
  // hard-gate categories rather than carrying a copy of the policy.
  onRevokeApprovalRule?: ((ruleId: string) => Promise<void>) | undefined
  onLoadHardGates?: (() => Promise<HardGateCategory[]>) | undefined
}) {
  const plan = latestArtifactForActiveSession(snapshot, "plan")
  const workingPlan = snapshot.workingPlans.find(
    (candidate) => candidate.sessionId === snapshot.activeSessionId,
  )
  const planRunning = snapshot.sessions.some(
    (session) => session.id === snapshot.activeSessionId && session.activeTurnId !== undefined,
  )
  const previewCandidate = latestArtifactForActiveSession(snapshot, "preview")
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | undefined>(previewCandidate?.id)
  const previewVariants = useMemo(
    () => previewVariantsForActiveSession(snapshot, selectedPreviewId),
    [selectedPreviewId, snapshot],
  )
  const preview = previewVariants.find((artifact) => artifact.id === selectedPreviewId) ?? previewVariants.at(-1)
  const annotations = useMemo(() => annotationsForActiveSession(snapshot), [snapshot])
  // Comments belong to the artifact they were left on. The preview shows the
  // selected variant's, another variant's show when it is selected, the plan
  // shows the plan's, and whatever is on none of those is listed under the
  // preview in its own labelled block so nothing is lost.
  const previewComments = annotations.filter((annotation) => preview !== undefined && annotation.artifactId === preview.id)
  const planComments = annotations.filter((annotation) => plan !== undefined && annotation.artifactId === plan.id)
  const variantIds = new Set(previewVariants.map((artifact) => artifact.id))
  const otherComments = annotations.filter((annotation) => !variantIds.has(annotation.artifactId) && annotation.artifactId !== plan?.id)
  const commentCount = (rows: readonly Annotation[]) => {
    const open = rows.filter((annotation) => annotation.status === "open").length
    return open === rows.length ? `${open} open` : `${open} open · ${rows.length} in all`
  }
  const archiveReadOnly = sessionIsArchiveReadOnly(snapshot.sessions.find(
    (session) => session.id === snapshot.activeSessionId,
  ))
  const previewFrameRef = useRef<HTMLIFrameElement>(null)
  const stageContainerRef = useRef<HTMLDivElement>(null)
  const [stageContainerWidth, setStageContainerWidth] = useState(0)
  const [deviceWidth, setDeviceWidth] = useState(768)
  const [compareRequested, setCompareRequested] = useState(false)
  const reviewLayout = reviewLayoutFor(stageContainerWidth, compareRequested, previewVariants.length)
  const previewControlLayout = previewControlLayoutFor(stageContainerWidth)
  const reviewStageCount = reviewLayout.stages
  const reviewStages = useMemo(
    () => previewStagesForReview(previewVariants, preview, reviewStageCount),
    [preview, previewVariants, reviewStageCount],
  )
  const comparisonStages = useMemo(() => reviewStages.slice(1), [reviewStages])
  const previewAuthorizationKey = artifactAuthorizationKey(preview ? [preview] : [])
  const comparisonAuthorizationKey = artifactAuthorizationKey(comparisonStages)
  const [bridgeState, setBridgeState] = useState(() => ({
    previewKey: preview ? `${preview.id}:${preview.revision}` : undefined,
    channel: createPreviewBridgeChannel(),
  }))
  const previewKey = preview ? `${preview.id}:${preview.revision}` : undefined
  let bridgeChannel = bridgeState.channel
  if (bridgeState.previewKey !== previewKey) {
    const nextBridgeState = { previewKey, channel: createPreviewBridgeChannel() }
    bridgeChannel = nextBridgeState.channel
    setBridgeState(nextBridgeState)
  }
  const [pickerActive, setPickerActive] = useState(false)
  const [selection, setSelection] = useState<PreviewBridgeSelectionMessage | null>(null)
  const [selectionVisualContext, setSelectionVisualContext] = useState<
    RpcParams<"annotation.create">["visualContextUpload"]
  >()
  const [comment, setComment] = useState("")
  const [annotationPending, setAnnotationPending] = useState(false)
  const [annotationError, setAnnotationError] = useState("")
  const [previewUrl, setPreviewUrl] = useState<string>()
  const [previewError, setPreviewError] = useState("")
  const [derivedArtifactPending, setDerivedArtifactPending] = useState<"print" | "download">()
  const [derivedArtifactError, setDerivedArtifactError] = useState("")
  const [comparisonStageUrls, setComparisonStageUrls] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  )
  const [previewThumbnailUrls, setPreviewThumbnailUrls] = useState<ReadonlyMap<string, string>>(() => new Map())
  const previewThumbnailLifecycle = useRef(new PreviewThumbnailLifecycle())
  const [anchorResolutions, setAnchorResolutions] = useState<ReadonlyMap<
    string,
    "selector" | "text-quote" | "bounding-box" | "unresolved"
  >>(() => new Map())
  const [bridgeReadyKey, setBridgeReadyKey] = useState<string>()
  const pendingAnchorResolutionBatch = useRef<PreviewBridgeResolveAnchorsMessage | undefined>(undefined)
  const queuedAnchorResolutionBatches = useRef<PreviewBridgeResolveAnchorsMessage[]>([])
  const [uncontrolledTab, setUncontrolledTab] = useState<string>(defaultTab)
  const activeTab = tab ?? uncontrolledTab
  const setActiveTab = (next: string) => {
    setUncontrolledTab(next)
    onTabChange?.(next)
  }
  const stageObservationKey = previewStageObservationKey(preview?.id, previewError)

  useEffect(() => {
    const element = stageContainerRef.current
    if (!element) return
    const update = () => setStageContainerWidth(element.getBoundingClientRect().width)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [stageObservationKey])

  useEffect(() => () => previewThumbnailLifecycle.current.clear(), [])

  useEffect(() => {
    let active = true
    setPreviewUrl(undefined)
    setPreviewError("")
    const [target] = artifactAuthorizationTargets(previewAuthorizationKey)
    if (!target || !connected || previewRefusal) return () => { active = false }
    void authorizeArtifact({ sessionId: target.sessionId, artifactId: target.id, revision: target.revision, purpose: "preview", bridgeChannel, parentOrigin: window.location.origin }).then(
      (access) => {
        if (active) setPreviewUrl(artifactUrlFor(rpcUrl, access))
      },
      (cause: unknown) => {
        if (!active) return
        setPreviewUrl(undefined)
        setPreviewError(
          cause instanceof Error ? cause.message : "Preview access could not be authorized",
        )
      },
    )
    return () => { active = false }
  }, [authorizeArtifact, bridgeChannel, connected, previewAuthorizationKey, rpcUrl, previewRefusal])

  useEffect(() => {
    let active = true
    setComparisonStageUrls(new Map())
    const targets = artifactAuthorizationTargets(comparisonAuthorizationKey)
    if (!targets.length || !connected || previewRefusal) return () => { active = false }
    const authorizeComparisonStages = async () => {
      const entries: Array<readonly [string, string]> = []
      await Promise.all(targets.map(async (target) => {
        try {
          const access = await authorizeArtifact({
            sessionId: target.sessionId,
            artifactId: target.id,
            revision: target.revision,
            purpose: "preview",
          })
          entries.push([target.id, artifactUrlFor(rpcUrl, access)])
        } catch {
          // Keep failed comparison stages sandboxed and blank.
        }
      }))
      if (active) setComparisonStageUrls(new Map(entries))
    }
    void authorizeComparisonStages()
    return () => { active = false }
  }, [authorizeArtifact, comparisonAuthorizationKey, connected, rpcUrl, previewRefusal])

  const postPickerState = useCallback((active: boolean) => {
    const message: PreviewBridgePickerMessage = {
      type: "domovoi.preview.picker",
      channel: bridgeChannel,
      active,
    }
    previewFrameRef.current?.contentWindow?.postMessage(message, "*")
  }, [bridgeChannel])

  const capturePreviewThumbnail = async () => {
    if (!captureAnnotation || !preview || !previewUrl) return
    const frame = previewFrameRef.current
    if (!frame) return
    const rect = previewThumbnailRect(frame.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight })
    if (!rect) return
    await capturePreviewThumbnailState({
      lifecycle: previewThumbnailLifecycle.current,
      artifactId: preview.id,
      revision: preview.revision,
      capture: () => captureAnnotation(rect),
      sync: setPreviewThumbnailUrls,
    })
  }

  const openDerivedArtifact = async (purpose: "print" | "download") => {
    if (!preview || !connected || derivedArtifactPending) return
    const printWindow = purpose === "print" ? window.open("about:blank", "_blank") : null
    if (printWindow) printWindow.opener = null
    setDerivedArtifactPending(purpose)
    setDerivedArtifactError("")
    try {
      const access = await authorizeArtifact({ sessionId: preview.sessionId, artifactId: preview.id, revision: preview.revision, purpose })
      const url = artifactUrlFor(rpcUrl, access)
      if (purpose === "print") {
        if (!printWindow) throw new Error("The browser blocked the print view")
        printWindow.location.replace(url)
      } else {
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = ""
        anchor.rel = "noopener noreferrer"
        anchor.click()
      }
    } catch (cause) {
      printWindow?.close()
      setDerivedArtifactError(cause instanceof Error ? cause.message : "The safe copy could not be prepared")
    } finally {
      setDerivedArtifactPending(undefined)
    }
  }

  const postNextAnchorResolutionBatch = useCallback(() => {
    if (pendingAnchorResolutionBatch.current) return
    const message = queuedAnchorResolutionBatches.current.shift()
    if (!message) return
    pendingAnchorResolutionBatch.current = message
    previewFrameRef.current?.contentWindow?.postMessage(message, "*")
  }, [])

  const startAnchorResolutionRequests = useCallback(() => {
    if (!preview) return
    queuedAnchorResolutionBatches.current = previewResolveAnchorMessages(
      bridgeChannel,
      preview.id,
      annotations
        .filter((annotation) => annotation.artifactId === preview.id)
        .map((annotation) => ({ annotationId: annotation.id, anchor: annotation.anchor })),
    )
    pendingAnchorResolutionBatch.current = undefined
    setAnchorResolutions(new Map())
    postNextAnchorResolutionBatch()
  }, [annotations, bridgeChannel, postNextAnchorResolutionBatch, preview])

  useEffect(() => {
    let active = true
    const receiveSelection = async (event: MessageEvent<unknown>) => {
      if (
        !preview
        || event.source !== previewFrameRef.current?.contentWindow
        || event.origin !== "null"
      ) return
      if (previewReadyFor(event.data, bridgeChannel, preview.id)) {
        setBridgeReadyKey(previewKey)
        return
      }
      const pendingBatch = pendingAnchorResolutionBatch.current
      const anchorResolutionMessage = pendingBatch
        ? anchorResolutionsFor(
            event.data,
            bridgeChannel,
            preview.id,
            pendingBatch.requestId,
            pendingBatch.annotations.map((annotation) => annotation.annotationId),
          )
        : undefined
      if (anchorResolutionMessage && pendingBatch) {
        setAnchorResolutions((current) => mergeAnchorResolutionBatch(
          current,
          anchorResolutionMessage.resolutions,
        ))
        pendingAnchorResolutionBatch.current = undefined
        postNextAnchorResolutionBatch()
        return
      }
      if (archiveReadOnly || !pickerActive) return
      const nextSelection = previewSelectionFor(event.data, bridgeChannel, preview.id)
      if (!nextSelection) return
      postPickerState(false)
      setPickerActive(false)
      let visualContextUpload: RpcParams<"annotation.create">["visualContextUpload"]
      const frame = previewFrameRef.current
      if (captureAnnotation && nextSelection.anchor.bbox && frame) {
        const frameRect = frame.getBoundingClientRect()
        visualContextUpload = await annotationCaptureUpload(
          captureAnnotation,
          { left: frameRect.left, top: frameRect.top, width: frameRect.width, height: frameRect.height },
          nextSelection.anchor.bbox,
          { width: window.innerWidth, height: window.innerHeight },
          preview.revision,
        )
      }
      if (!active) return
      setSelectionVisualContext(visualContextUpload)
      setSelection(nextSelection)
      setComment("")
      setAnnotationError("")
    }
    window.addEventListener("message", receiveSelection)
    return () => {
      active = false
      window.removeEventListener("message", receiveSelection)
    }
  }, [annotations, archiveReadOnly, bridgeChannel, captureAnnotation, pickerActive, postNextAnchorResolutionBatch, postPickerState, preview, previewKey])

  useEffect(() => {
    setPickerActive(false)
    setSelection(null)
    setSelectionVisualContext(undefined)
    setComment("")
    setAnnotationError("")
    setAnchorResolutions(new Map())
    setBridgeReadyKey(undefined)
    pendingAnchorResolutionBatch.current = undefined
    queuedAnchorResolutionBatches.current = []
  }, [archiveReadOnly, preview?.id, preview?.revision])

  useEffect(() => {
    if (bridgeReadyKey === previewKey) startAnchorResolutionRequests()
  }, [annotations, bridgeReadyKey, previewKey, startAnchorResolutionRequests])

  const togglePicker = () => {
    if (archiveReadOnly) return
    const active = !pickerActive
    setPickerActive(active)
    setAnnotationError("")
    postPickerState(active)
  }

  const saveAnnotation = async () => {
    const body = comment.trim()
    const sessionId = snapshot.activeSessionId
    if (archiveReadOnly || !body || !selection || !sessionId || annotationPending) return
    setAnnotationPending(true)
    setAnnotationError("")
    try {
      await onCreateAnnotation({
        sessionId,
        artifactId: selection.artifactId,
        anchor: selection.anchor,
        body,
        ...(preview?.variant ? { variantId: preview.variant.id } : {}),
        ...(selectionVisualContext ? { visualContextUpload: selectionVisualContext } : {}),
      })
      setSelection(null)
      setSelectionVisualContext(undefined)
      setComment("")
    } catch (cause) {
      setAnnotationError(cause instanceof Error ? cause.message : "The annotation could not be saved")
    } finally {
      setAnnotationPending(false)
    }
  }

  const planCommentsBlock = planComments.length ? (
    <section aria-label="Comments on the plan" className="mt-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-eyebrow tracking-[.13em] text-faint">COMMENTS ON THE PLAN</span>
        <span className="font-machine text-mono-xs text-faint">{commentCount(planComments)}</span>
      </div>
      <AnnotationComments
        annotations={planComments}
        anchorResolutions={anchorResolutions}
        readOnly={archiveReadOnly}
        onReply={onReplyToAnnotation}
        onSetStatus={onSetAnnotationStatus}
      />
    </section>
  ) : null
  return (
    <aside aria-label="Session artifacts" data-workspace-panel="dock" className="flex h-full min-w-0 flex-col bg-sidebar">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full gap-0">
        <div className="flex h-11 items-center border-b px-2">
          <TabsList variant="line" className="min-w-0 flex-1 justify-start overflow-x-auto">
            <TabsTrigger value="plan"><FileTextIcon />Plan</TabsTrigger>
            <TabsTrigger value="preview"><CodeXmlIcon />Preview</TabsTrigger>
            <TabsTrigger value="changes"><FileDiffIcon />Changes</TabsTrigger>
            <TabsTrigger value="terminal"><TerminalSquareIcon />Terminal</TabsTrigger>
            <TabsTrigger value="history"><HistoryIcon />History</TabsTrigger>
            <TabsTrigger value="checkpoints"><GitCommitHorizontalIcon />Checkpoints</TabsTrigger>
            <TabsTrigger value="rules"><ShieldCheckIcon />Rules</TabsTrigger>
          </TabsList>
          <Button ref={collapseButtonRef} variant="ghost" size="icon-xs" aria-label="Collapse dock" onClick={onCollapse}><PanelRightCloseIcon /></Button>
        </div>
        <TabsContent value="preview" className="min-h-0 overflow-auto p-3">
          {previewRefusal ? <Alert><AlertTitle>Remote preview unavailable</AlertTitle><AlertDescription>{previewRefusal}</AlertDescription></Alert> : preview ? (
            <div className="flex min-h-full flex-col overflow-hidden rounded-xl border bg-background shadow-[var(--shadow-md)]">
              {previewVariants.length > 1 ? (
                <div className="border-b p-2">
                  <ScrollArea className="w-full whitespace-nowrap" aria-label="Design variants; use J and K or arrow keys to move">
                    <div className="flex gap-2 pb-2" onKeyDown={(event) => {
                      const direction = event.key === "j" || event.key === "ArrowRight" ? 1 : event.key === "k" || event.key === "ArrowLeft" ? -1 : 0
                      if (!direction) return
                      event.preventDefault()
                      const current = Math.max(0, previewVariants.findIndex((artifact) => artifact.id === preview.id))
                      setSelectedPreviewId(previewVariants[(current + direction + previewVariants.length) % previewVariants.length]?.id)
                    }}>
                      {previewVariants.map((artifact) => (
                        <Button key={artifact.id} variant={artifact.id === preview.id ? "secondary" : "outline"} className="min-h-11 min-w-28 flex-col items-start" aria-current={artifact.id === preview.id ? "true" : undefined} onClick={() => setSelectedPreviewId(artifact.id)}>
                          <PreviewVariantThumbnail url={previewThumbnailUrls.get(`${artifact.id}:${artifact.revision}`)} />
                          <span>{artifact.variant?.label ?? artifact.title}</span>
                          <span className="text-micro text-muted-foreground">{artifact.id === preview.id ? "Selected" : `revision ${artifact.revision}`}</span>
                        </Button>
                      ))}
                    </div>
                    <ScrollBar orientation="horizontal" />
                  </ScrollArea>
                </div>
              ) : null}
              <div className={cn("flex min-h-10 items-center justify-between gap-2 border-b px-3 py-1", previewToolbarLayoutFor(stageContainerWidth) === "wrap" && "flex-wrap")}>
                <div><p className="m-0 text-[11px] font-medium">{preview.title}</p><p className="m-0 font-machine text-mono-xs text-faint">revision {preview.revision} · sandboxed</p></div>
                <div className={cn("flex min-w-0 items-center justify-end gap-2", previewControlLayout.wrap && "flex-wrap", previewControlLayout.fullWidth && "w-full")}>
                  <Button variant="outline" size="xs" className="min-h-11" disabled={!connected || Boolean(derivedArtifactPending)} aria-label="Open sanitized print view" onClick={() => void openDerivedArtifact("print")}><PrinterIcon data-icon="inline-start" />{derivedArtifactPending === "print" ? "Preparing" : "Print view"}</Button>
                  <Button variant="outline" size="xs" className="min-h-11" disabled={!connected || Boolean(derivedArtifactPending)} aria-label="Download sanitized offline HTML copy" onClick={() => void openDerivedArtifact("download")}><DownloadIcon data-icon="inline-start" />{derivedArtifactPending === "download" ? "Preparing" : "Download safe copy"}</Button>
                  <ToggleGroup type="single" value={String(deviceWidth)} onValueChange={(value) => { if (value) setDeviceWidth(Number(value)) }} aria-label="Preview device width">
                    {[390, 768, 1440].map((width) => <ToggleGroupItem key={width} value={String(width)} className="min-h-11 min-w-11" aria-label={`${width} pixel preview`}>{width}</ToggleGroupItem>)}
                  </ToggleGroup>
                  {previewVariants.length > 1 ? <Button variant="outline" size="xs" className="min-h-11" aria-pressed={reviewLayout.compare} disabled={stageContainerWidth > 0 && stageContainerWidth < 760} onClick={() => setCompareRequested((value) => !value)}>Compare</Button> : null}
                  {previewVariants.length > 1 && stageContainerWidth > 0 && stageContainerWidth < 760 ? <span className="sr-only" role="status">Compare is unavailable at this width; showing the selected variant.</span> : null}
                  {!archiveReadOnly ? (
                    <Button
                      variant={pickerActive ? "secondary" : "outline"}
                      size="xs"
                      className="min-h-11"
                      aria-pressed={pickerActive}
                      onClick={togglePicker}
                    >
                      <MessageSquarePlusIcon />
                      {pickerActive ? "Select element" : "Annotate"}
                    </Button>
                  ) : null}
                  <Badge variant="success">Live</Badge>
                </div>
              </div>
              <p className="m-0 border-b px-3 py-1 text-micro text-muted-foreground">Safe copies remove scripts, forms, and external assets.</p>
              {derivedArtifactError ? <Alert variant="destructive" className="m-3 w-auto" aria-live="polite"><CircleStopIcon /><AlertTitle>Safe copy unavailable</AlertTitle><AlertDescription>{derivedArtifactError}</AlertDescription></Alert> : null}
              {previewError ? (
                <Alert variant="destructive" className="m-3 w-auto" aria-live="polite">
                  <CircleStopIcon />
                  <AlertTitle>Preview unavailable</AlertTitle>
                  <AlertDescription>{previewError}</AlertDescription>
                </Alert>
              ) : (
                <div
                  ref={stageContainerRef}
                  className="grid min-h-0 flex-1 gap-3 overflow-auto p-2"
                  style={{ gridTemplateColumns: previewStageGridColumns(reviewLayout.stages) }}
                >
                {reviewStages.map((artifact, index) => (
                  <iframe
                    key={artifact.id}
                    ref={index === 0 ? previewFrameRef : undefined}
                    className="min-h-0 w-full justify-self-center border bg-background"
                    style={{ maxWidth: deviceWidth }}
                    referrerPolicy="no-referrer"
                    sandbox="allow-scripts"
                    src={index === 0 ? previewUrl ?? "about:blank" : comparisonStageUrls.get(artifact.id) ?? "about:blank"}
                    title={index === 0 ? artifact.title : `${artifact.title} comparison`}
                    onLoad={index === 0 ? () => {
                      postPickerState(pickerActive)
                      void capturePreviewThumbnail()
                    } : undefined}
                  />
                ))}
                </div>
              )}
            </div>
          ) : (
            <Empty className="min-h-full border">
              <EmptyHeader><EmptyMedia variant="icon"><CodeXmlIcon /></EmptyMedia><EmptyTitle>No preview yet</EmptyTitle><EmptyDescription>HTML artifacts created by the agent appear here.</EmptyDescription></EmptyHeader>
            </Empty>
          )}
          {/* v2 draws the comments on a variant under the preview frame, not
              as a tab of their own; the count names how many are still open. */}
          <section aria-label="Comments on this preview" className="mx-auto mt-4 flex max-w-[640px] flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-eyebrow tracking-[.13em] text-faint">{preview?.variant ? `COMMENTS ON ${preview.variant.label.toUpperCase()}` : "COMMENTS ON THIS PREVIEW"}</span>
              <span className="font-machine text-mono-xs text-faint">{commentCount(previewComments)}</span>
            </div>
            <AnnotationComments
              annotations={previewComments}
              anchorResolutions={anchorResolutions}
              readOnly={archiveReadOnly}
              onReply={onReplyToAnnotation}
              onSetStatus={onSetAnnotationStatus}
            />
            {otherComments.length ? (
              <div className="mt-2 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-eyebrow tracking-[.13em] text-faint">COMMENTS ON OTHER ARTIFACTS</span>
                  <span className="font-machine text-mono-xs text-faint">{commentCount(otherComments)}</span>
                </div>
                <AnnotationComments
                  annotations={otherComments}
                  anchorResolutions={anchorResolutions}
                  readOnly={archiveReadOnly}
                  onReply={onReplyToAnnotation}
                  onSetStatus={onSetAnnotationStatus}
                />
              </div>
            ) : null}
          </section>
        </TabsContent>
        <TabsContent value="plan" className="min-h-0">
          {workingPlan ? (
            <ScrollArea className="h-full">
              <div className="p-3">
                <WorkingPlanCard
                  plan={workingPlan}
                  running={planRunning}
                  readOnly={archiveReadOnly}
                  {...(onEditPlan ? { onEditPlan } : {})}
                  {...(onDiscardPlanEdit ? { onDiscardEdit: onDiscardPlanEdit } : {})}
                />
                {planCommentsBlock}
              </div>
            </ScrollArea>
          ) : plan?.content ? (
            <ScrollArea className="h-full">
              <article className="p-4">
                <div className="mb-4 border-b pb-3">
                  <h2 className="m-0 text-[13px] font-semibold">{plan.title}</h2>
                  <p className="mt-1 font-machine text-mono-xs text-faint">revision {plan.revision}</p>
                </div>
                <MarkdownQuickView source={plan.content} canonicalAvailable={Boolean(preview)} onOpenCanonical={() => setActiveTab("preview")} />
                {planCommentsBlock}
              </article>
            </ScrollArea>
          ) : (
            <ScrollArea className="h-full">
              <Empty className="min-h-48 border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
                  <EmptyTitle>No plan content yet</EmptyTitle>
                  <EmptyDescription>Plan updates from the active agent appear here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
              {planCommentsBlock ? <div className="px-3 pb-3">{planCommentsBlock}</div> : null}
            </ScrollArea>
          )}
        </TabsContent>
        <TabsContent value="changes" className="min-h-0">
          <SessionEvidencePanel
            connected={connected}
            readOnly={archiveReadOnly}
            sessionId={snapshot.activeSessionId}
            onLoad={onLoadSessionEvidence}
            onRevertFile={onRevertSessionFile}
          />
        </TabsContent>
        <TabsContent value="terminal" className="min-h-0 bg-code">
          <Suspense fallback={(
            <Empty className="min-h-full border-0 text-muted-foreground">
              <EmptyHeader>
                <EmptyMedia variant="icon"><TerminalSquareIcon /></EmptyMedia>
                <EmptyTitle>Loading terminal</EmptyTitle>
                <EmptyDescription>Preparing the interactive terminal renderer.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}>
            <TerminalPane
              connected={connected}
              controls={terminalControls}
              machineName={snapshot.machine.name}
              sessionId={snapshot.activeSessionId}
            />
          </Suspense>
        </TabsContent>
        <TabsContent value="history" className="min-h-0">
          <HistoryPanel
            sessionId={snapshot.activeSessionId}
            connected={connected}
            onLoad={onLoadSessionHistory}
            onRestoreCheckpoint={onRestoreCheckpoint}
            worktreeName={worktreeName}
            onForkCheckpoint={onForkCheckpoint}
            // An archived session and a running turn hold this shut, and so
            // does a restore already in flight. The in-flight half has to come
            // from the shell: the dock cannot see the thread's own pending
            // state, and a snapshot arrives too late to stop a second click.
            restoreBlocked={
              restoreBusy
              || sessionIsArchiveReadOnly(activeSession(snapshot))
              || Boolean(activeSession(snapshot)?.activeTurnId)
            }
          />
        </TabsContent>
        <TabsContent value="checkpoints" className="min-h-0">
          <CheckpointsPanel
            sessionId={snapshot.activeSessionId}
            connected={connected}
            revision={latestCheckpointRevision(snapshot, snapshot.activeSessionId)}
            onLoad={onLoadSessionHistory}
            onRestoreCheckpoint={onRestoreCheckpoint}
            onForkCheckpoint={onForkCheckpoint}
            restoreBlocked={
              restoreBusy
              || sessionIsArchiveReadOnly(activeSession(snapshot))
              || Boolean(activeSession(snapshot)?.activeTurnId)
            }
          />
        </TabsContent>
        <TabsContent value="rules" className="min-h-0">
          {/* Rules are the project's, not the session's: an archived session
              selected in the thread does not take away the right to revoke a
              rule. The protocol has no watch-only client, so nothing dims
              Revoke here; a refusal comes back from the daemon and is shown. */}
          {onRevokeApprovalRule && onLoadHardGates ? (
            <RulesPanel
              rules={snapshot.approvalRules.filter((rule) => rule.projectId === snapshot.project?.id)}
              projectName={snapshot.project?.name ?? "this project"}
              machineName={snapshot.machine.name}
              onRevoke={onRevokeApprovalRule}
              onLoadHardGates={onLoadHardGates}
            />
          ) : null}
        </TabsContent>
      </Tabs>
      <Dialog
        open={!archiveReadOnly && selection !== null}
        onOpenChange={(open) => {
          if (open || annotationPending) return
          setSelection(null)
          setSelectionVisualContext(undefined)
          setComment("")
          setAnnotationError("")
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Annotate preview</DialogTitle>
            <DialogDescription className="break-words">
              {selection?.label ?? "Selected preview element"}
            </DialogDescription>
          </DialogHeader>
          {annotationError ? (
            <Alert variant="destructive" aria-live="polite">
              <CircleStopIcon />
              <AlertTitle>Annotation failed</AlertTitle>
              <AlertDescription>{annotationError}</AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="preview-annotation">Comment</FieldLabel>
              <Textarea
                id="preview-annotation"
                value={comment}
                rows={4}
                autoFocus
                disabled={annotationPending}
                placeholder="Describe what should change or what needs review"
                onChange={(event) => setComment(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={annotationPending}
              onClick={() => setSelection(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={!comment.trim() || annotationPending}
              onClick={() => void saveAnnotation()}
            >
              {annotationPending ? "Saving annotation" : "Save annotation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}

export function AnnotationComments({
  annotations,
  anchorResolutions = new Map(),
  readOnly,
  onReply,
  onSetStatus,
}: {
  annotations: Annotation[]
  anchorResolutions?: ReadonlyMap<string, "selector" | "text-quote" | "bounding-box" | "unresolved">
  readOnly: boolean
  onReply: (annotationId: string, body: string) => Promise<void>
  onSetStatus: (annotationId: string, status: Annotation["status"]) => Promise<void>
}) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [reply, setReply] = useState("")
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState("")

  const submitReply = async (annotationId: string) => {
    const body = reply.trim()
    if (!body || pendingId) return
    setPendingId(annotationId)
    setError("")
    try {
      await onReply(annotationId, body)
      setReply("")
      setReplyingTo(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The annotation reply could not be saved")
    } finally {
      setPendingId(null)
    }
  }

  const setStatus = async (annotation: Annotation) => {
    if (pendingId) return
    setPendingId(annotation.id)
    setError("")
    try {
      await onSetStatus(annotation.id, annotation.status === "open" ? "resolved" : "open")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The annotation status could not be changed")
    } finally {
      setPendingId(null)
    }
  }

  return (
    <ScrollArea className="h-full">
      {annotations.length ? (
        <div className="flex flex-col gap-3 p-3">
          {error ? (
            <Alert variant="destructive" aria-live="polite">
              <CircleStopIcon />
              <AlertTitle>Annotation update failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {annotations.map((annotation) => {
            const pending = pendingId === annotation.id
            const isReplying = replyingTo === annotation.id
            const anchorResolution = anchorResolutions.get(annotation.id)
            return (
              <Card key={annotation.id} size="sm">
                <CardHeader>
                  <CardTitle className="min-w-0 break-words text-[12px] leading-relaxed">{annotation.body}</CardTitle>
                  <CardDescription className="font-machine text-mono-xs">
                    {annotation.origin} · {annotation.variantId ?? annotation.artifactId}
                    {annotation.statusChangedBy ? ` · ${annotation.status} by ${annotation.statusChangedBy}` : ""}
                  </CardDescription>
                  <CardAction>
                    <Badge variant={annotation.status === "open" ? "warning" : "success"}>{annotation.status}</Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <div className="break-words rounded-md border bg-code px-2.5 py-2 font-machine text-mono-xs leading-relaxed text-muted-foreground">
                    {annotation.anchor.textQuote
                      ? `“${annotation.anchor.textQuote}”`
                      : annotation.anchor.cssSelector ?? "Visual selection"}
                    {anchorResolution ? (
                      <Badge
                        variant={anchorResolution === "unresolved" ? "destructive" : "outline"}
                        className="ml-2"
                      >
                        {anchorResolution === "selector" ? "selector anchor" : null}
                        {anchorResolution === "text-quote" ? "text anchor" : null}
                        {anchorResolution === "bounding-box" ? "visual anchor" : null}
                        {anchorResolution === "unresolved" ? "anchor unavailable" : null}
                      </Badge>
                    ) : null}
                  </div>
                  {annotation.visualContext ? (
                    <p className="m-0 font-machine text-mono-xs text-faint">
                      {annotation.visualContext.status === "available"
                        ? `visual context · ${annotation.visualContext.width}×${annotation.visualContext.height} · revision ${annotation.visualContext.artifactRevision}`
                        : `visual context unavailable · ${annotation.visualContext.reason}`}
                    </p>
                  ) : null}
                  {annotation.thread.map((threadReply) => (
                    <div key={threadReply.id} className="break-words border-l border-border pl-2 text-[11px] leading-relaxed text-muted-foreground">
                      <span className="font-machine text-mono-xs text-faint">{threadReply.origin}</span><br />
                      {threadReply.body}
                    </div>
                  ))}
                </CardContent>
                {!readOnly ? <CardFooter className="flex-col items-stretch gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={pendingId !== null || (replyingTo !== null && !isReplying)}
                      onClick={() => {
                        setError("")
                        setReply("")
                        setReplyingTo(isReplying ? null : annotation.id)
                      }}
                    >
                      {isReplying ? "Cancel reply" : "Reply"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pendingId !== null}
                      onClick={() => void setStatus(annotation)}
                    >
                      {pending ? "Saving" : annotation.status === "open" ? "Resolve" : "Reopen"}
                    </Button>
                  </div>
                  {isReplying ? (
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor={`annotation-reply-${annotation.id}`}>Reply</FieldLabel>
                        <Textarea
                          id={`annotation-reply-${annotation.id}`}
                          value={reply}
                          rows={3}
                          disabled={pending}
                          placeholder="Add context for the next agent round"
                          onChange={(event) => setReply(event.target.value)}
                        />
                      </Field>
                      <Button
                        size="sm"
                        disabled={!reply.trim() || pending}
                        onClick={() => void submitReply(annotation.id)}
                      >
                        {pending ? "Saving reply" : "Save reply"}
                      </Button>
                    </FieldGroup>
                  ) : null}
                </CardFooter> : null}
              </Card>
            )
          })}
        </div>
      ) : (
        <Empty className="min-h-full border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon"><MessageSquareTextIcon /></EmptyMedia>
            <EmptyTitle>No annotations yet</EmptyTitle>
            <EmptyDescription>Comments anchored to plans and previews appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </ScrollArea>
  )
}

export function DockRail({ onExpand, expandButtonRef }: { onExpand: () => void; expandButtonRef?: RefObject<HTMLButtonElement | null> }) {
  // One icon per dock tab, in the tab list's order.
  const items = [FileTextIcon, CodeXmlIcon, FileDiffIcon, TerminalSquareIcon, HistoryIcon, GitCommitHorizontalIcon, ShieldCheckIcon]
  return (
    <aside aria-label="Collapsed artifact dock" data-workspace-panel="dock-rail" className="flex w-[var(--shell-rail)] shrink-0 flex-col items-center gap-2 border-l bg-sidebar py-2">
      <Tooltip><TooltipTrigger asChild><Button ref={expandButtonRef} variant="ghost" size="icon-sm" aria-label="Expand artifact dock" onClick={onExpand}><PanelRightCloseIcon className="rotate-180" /></Button></TooltipTrigger><TooltipContent side="left">Expand artifact dock</TooltipContent></Tooltip>
      <Separator />
      {items.map((Icon, index) => <Button key={index} variant="ghost" size="icon-sm" aria-label="Artifact dock item" onClick={onExpand}><Icon /></Button>)}
    </aside>
  )
}
