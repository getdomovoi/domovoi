import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useWindowDimensions, View } from "react-native"
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context"
import {
  artifactAuthorizeResultSchema,
  enabledSkillsMissingFromCatalog,
  selectableTurnSkills,
  skillSummariesSchema,
  turnSkillRefusalFrom,
  turnSkillSelectionFor,
  workspaceSnapshotSchema,
  type ApprovalDecision,
  type FleetEntry,
  type PermissionMode,
  type RpcMethod,
  type RpcParams,
  type SkillSummary,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { artifactRows, findArtifact, previewVariants } from "./artifact-rows"
import { artifactUrlFor } from "./artifact-url"
import { mutationCall, watchingReason } from "./client-access"
import { previewChannel, previewParentOrigin, type PreviewSelection } from "./preview-bridge"
import { connectionNotice } from "./connection-notice"
import { decisionProblem } from "./decision-problem"
import { ConfirmSheet } from "./components/confirm-sheet"
import { FreshSessionSheet } from "./components/fresh-session-sheet"
import { StopSheet } from "./components/stop-sheet"
import { ShellNotice } from "./components/shell-notice"
import { SkillSheet } from "./components/skill-sheet"
import { normalizeTab, TabBar, type Tab } from "./components/tab-bar"
import { clearCredential, loadCredential, saveCredential, type DaemonCredential } from "./lib/credentials"
import { useDaemon } from "./lib/use-daemon"
import { connectedMachineActivity } from "./machine-activity"
import { launchPhases } from "./launch-state"
import * as ImagePicker from "expo-image-picker"

import { attachmentFrom, attachmentRefusalMessage, attachmentSummary, maximumSessionAttachments, type Attachment } from "./attachments"
import { planForSession, planStepEdit, planSummary, unpinnedAfter } from "./plan-rows"
import { startLikeRequest } from "./start-like"
import { ApprovalScreen } from "./screens/approval"
import { DenyExplainScreen } from "./screens/deny-explain"
import { ArtifactScreen, type PreviewRender } from "./screens/artifact"
import { fleetLoader } from "./fleet-load"
import { freshSessionReadiness, startFreshSession } from "./fresh-session"
import { MachinesScreen } from "./screens/fleet"
import { annotationRows } from "./review-rows"
import { SessionScreen } from "./screens/session"
import { SessionsScreen } from "./screens/sessions"
import { PairScanScreen, usePairCameraPermission } from "./screens/pair-scan"
import { SettingsScreen } from "./screens/settings"
import { UnpairedScreen } from "./screens/unpaired"
import { promptProblem, sendReadinessOverSocket, sessionDetail } from "./session-detail"
import { queuedCancelParams, sendDelivery } from "./session-delivery"
import { shellState, unreachableShell } from "./shell-state"
import { waitingCount } from "./session-rows"
import { TabletShell } from "./tablet-shell"
import { useTheme } from "./theme/theme-provider"
import {
  missingSkillProblem,
  refusalMessage,
  skillPickerRows,
  skillSelectionLabel,
} from "./turn-skills"
import "./global.css"

export function App() {
  const { preference, setPreference } = useTheme()
  const { width } = useWindowDimensions()
  const tablet = width >= 768
  const [tab, setTab] = useState<Tab>(() => normalizeTab("sessions"))
  const selectTab = useCallback((value: unknown) => setTab(normalizeTab(value)), [])
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [connectTo, setConnectTo] = useState<DaemonCredential | undefined>(undefined)
  const [pairingMode, setPairingMode] = useState<"scan" | "type" | undefined>(undefined)
  const [cameraPermission, requestCameraPermission] = usePairCameraPermission()
  const [restoring, setRestoring] = useState(true)
  const [openApprovalId, setOpenApprovalId] = useState<string | undefined>(undefined)
  const [openSessionId, setOpenSessionId] = useState<string | undefined>(undefined)
  const [openArtifactId, setOpenArtifactId] = useState<string | undefined>(undefined)
  const [deciding, setDeciding] = useState(false)
  // Denying with a reason is its own screen over the approval, so backing out
  // of it returns to the decision rather than to the list.
  const [explaining, setExplaining] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [confirmPauseSession, setConfirmPauseSession] = useState(false)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [sendProblem, setSendProblem] = useState("")
  const [decideProblem, setDecideProblem] = useState("")
  // Frames 13 and 14: what the next turn carries besides words. Held here
  // and sent with the turn; nothing is kept once the send is answered.
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachProblem, setAttachProblem] = useState("")
  const pickImage = async (source: "library" | "camera") => {
    setAttachProblem("")
    if (attachments.length >= maximumSessionAttachments) {
      setAttachProblem(`Two images per turn. Remove one to add another.`)
      return
    }
    if (source === "camera") {
      const permission = await ImagePicker.requestCameraPermissionsAsync()
      if (!permission.granted) {
        setAttachProblem("This phone has not allowed Domovoi to use the camera.")
        return
      }
    }
    const result = source === "library"
      ? await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 1 })
      : await ImagePicker.launchCameraAsync({ base64: true, quality: 1 })
    if (result.canceled) return
    const asset = result.assets[0]
    if (!asset) return
    const read = attachmentFrom(asset)
    if (!read.ok) {
      setAttachProblem(read.reason)
      return
    }
    setAttachments((current) => [...current, read.attachment])
  }
  // The plan starts pinned: the design leads the thread with a strip saying
  // where the machine is, and the whole plan is one tap away. Unpinning
  // collapses it into the thread. Held here, not in the screen, so leaving
  // and coming back finds it where it was.
  // Kept per session: unpinning one plan says nothing about another, and a
  // person coming back to session B should find B as they left B. Pinned is
  // the default, so what is remembered is the unpinned ones.
  const [unpinnedPlans, setUnpinnedPlans] = useState<ReadonlySet<string>>(new Set())
  const pinPlan = (sessionId: string, pinned: boolean) => {
    setUnpinnedPlans((previous) => unpinnedAfter(previous, sessionId, pinned))
  }
  // A turn costs money, and two taps land in the same frame before the sending
  // state has re-rendered anything. The latch is read and set synchronously, so
  // the second tap has nothing left to do.
  const inFlightSend = useRef(false)
  // Undefined is "the person has not chosen", which leaves the project's own
  // skills alone. An empty set is a deliberate "no skills this turn". The two
  // are different requests and the daemon treats them differently.
  const [chosenSkills, setChosenSkills] = useState<ReadonlySet<string> | undefined>(undefined)
  const [skillCatalog, setSkillCatalog] = useState<SkillSummary[] | undefined>(undefined)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillProblem, setSkillProblem] = useState("")
  const [fleet, setFleet] = useState<FleetEntry[] | undefined>(undefined)
  const [fleetLoading, setFleetLoading] = useState(false)
  const [fleetProblem, setFleetProblem] = useState("")
  const [confirmPause, setConfirmPause] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [freshOpen, setFreshOpen] = useState(false)
  const [freshStarting, setFreshStarting] = useState(false)
  const [freshProblem, setFreshProblem] = useState("")
  const [composerFocused, setComposerFocused] = useState(false)
  // Stable, so the thread's memoized rows are not redrawn on every keystroke.
  const watchReceipt = useCallback(() => setComposerFocused(false), [])
  // How long an approval has been waiting is only true for as long as the
  // clock it was measured against. It ticks while the list is on screen and
  // stops when it is not, because nothing off screen needs a fresh minute.
  const [now, setNow] = useState(() => Date.now())
  // The tab bar floats over the screen behind it, so the screen behind it has
  // to be told what it covers. The bar measures itself and reports that here.
  const [tabFootprint, setTabFootprint] = useState(0)

  // The saved credential is what makes the app usable the second time it is
  // opened, so it is restored before anything is drawn.
  useEffect(() => {
    let live = true
    void loadCredential().then((saved) => {
      if (!live) return
      if (saved) {
        setUrl(saved.url)
        setToken(saved.token)
        setConnectTo(saved)
      }
      setRestoring(false)
    })
    return () => { live = false }
  }, [])

  // Built before the connection, because the connection hands it every fleet the
  // daemon pushes.
  const [fleetLoads] = useState(() => fleetLoader({
    setFleet,
    setLoading: setFleetLoading,
    setProblem: setFleetProblem,
  }))

  // What the daemon knows this device as. The pairing code decided it, and
  // every call names it, because the daemon refuses one that names another. A
  // credential of unknown kind is kept with the kind the daemon accepted.
  const { snapshot, status, fault, protocolProblem, call, refresh, reconnect, imageAttachments, clientAccess, client } = useDaemon(
    connectTo?.url,
    connectTo?.token,
    connectTo?.client,
    fleetLoads.accept,
    (kind) => {
      if (connectTo) void saveCredential({ ...connectTo, client: kind })
    },
  )
  const mutate = useCallback(
    <M extends RpcMethod>(method: M, params: RpcParams<M>) => mutationCall(clientAccess, call, method, params),
    [call, clientAccess],
  )
  const notice = connectionNotice(status, fault, snapshot !== undefined, protocolProblem)
  const shell = shellState({
    restoringCredential: restoring,
    hasCredential: connectTo !== undefined,
    hasSnapshot: snapshot !== undefined,
    fault,
  })
  const waiting = snapshot ? waitingCount(snapshot) : 0
  const freshReadiness = snapshot ? freshSessionReadiness(snapshot) : undefined
  // No daemon has been named at all. That is a different screen from a daemon
  // that will not answer: every tab has its own reason for being empty, and
  // Settings is not empty at all. ShellNotice answers the reaching and refused
  // states instead, so the two never both claim this one.
  const unpaired = shell.kind === "unpaired"
  // The same fact narrowed for the screen that draws it, so a state answered by
  // UnpairedScreen cannot also reach ShellNotice.
  const unreachable = unreachableShell(shell)
  const phases = launchPhases({
    restoringCredential: restoring,
    hasCredential: connectTo !== undefined,
    hasSnapshot: snapshot !== undefined,
    status,
    fault,
    address: connectTo?.url ?? "",
  })

  // The snapshot describes the daemon this phone is talking to, so it is the
  // one machine in the fleet whose sessions and tools the phone can count.
  const activity = useMemo(
    () => snapshot ? connectedMachineActivity(snapshot) : undefined,
    [snapshot],
  )

  const openApproval = useMemo(
    () => snapshot?.approvals.find((approval) => approval.id === openApprovalId),
    [openApprovalId, snapshot],
  )

  // An approval answered on another device leaves this phone holding a reason
  // for a decision that no longer exists. The explain screen is closed with it,
  // so the next approval opens on its own decision rather than on this one.
  useEffect(() => {
    if (!openApproval) setExplaining(false)
  }, [openApproval])

  useEffect(() => {
    if (clientAccess === "watching") setExplaining(false)
  }, [clientAccess])

  const openSession = useMemo(
    () => snapshot && openSessionId ? sessionDetail(snapshot, openSessionId, clientAccess) : undefined,
    [clientAccess, openSessionId, snapshot],
  )

  const openArtifacts = useMemo(
    () => snapshot && openSessionId ? artifactRows(snapshot, openSessionId) : [],
    [openSessionId, snapshot],
  )

  const openArtifact = useMemo(
    () => snapshot && openArtifactId ? findArtifact(snapshot, openArtifactId) : undefined,
    [openArtifactId, snapshot],
  )

  const openArtifactComments = useMemo(
    () => snapshot && openArtifactId ? annotationRows(snapshot, openArtifactId) : [],
    [openArtifactId, snapshot],
  )

  const openVariants = useMemo(
    () => snapshot && openArtifactId ? previewVariants(snapshot, openArtifactId) : [],
    [openArtifactId, snapshot],
  )

  // A preview's render is fetched with a grant the daemon signs for one
  // artifact at one revision. Asked for when the preview opens and again when
  // its revision moves; what came back, or why nothing did, is what the screen
  // shows. The grant answers to the artifact it was asked for, so a reply that
  // lands after the person moved on is dropped rather than shown under the
  // wrong title.
  const [previewRender, setPreviewRender] = useState<PreviewRender | undefined>(undefined)
  // Bumped by Try again on a failed render; the effect below re-runs on it.
  const [renderAttempt, setRenderAttempt] = useState(0)
  const openPreviewId = openArtifact?.type === "preview" ? openArtifact.id : undefined
  const openPreviewRevision = openArtifact?.type === "preview" ? openArtifact.revision : undefined
  const openPreviewSessionId = openArtifact?.type === "preview" ? openArtifact.sessionId : undefined
  useEffect(() => {
    if (!openPreviewId || openPreviewRevision === undefined || !openPreviewSessionId) {
      setPreviewRender(undefined)
      return
    }
    let current = true
    setPreviewRender({ state: "pending" })
    void (async () => {
      try {
        // The bridge is asked for with the grant: the daemon injects it into
        // the render for this channel. The render's origin is opaque under
        // its sandbox, so the parent it answers to is "null".
        const channel = previewChannel()
        const access = artifactAuthorizeResultSchema.parse(await call("artifact.authorize", {
          sessionId: openPreviewSessionId,
          artifactId: openPreviewId,
          revision: openPreviewRevision,
          purpose: "preview",
          bridgeChannel: channel,
          parentOrigin: previewParentOrigin,
          client,
        }))
        if (current) setPreviewRender({ state: "ready", url: artifactUrlFor(url, access), channel })
      } catch (cause) {
        if (current) setPreviewRender({ state: "failed", reason: cause instanceof Error ? cause.message : "The daemon refused the grant" })
      }
    })()
    return () => { current = false }
  }, [call, client, openPreviewId, openPreviewRevision, openPreviewSessionId, renderAttempt, url])

  const openPlan = useMemo(() => {
    if (!snapshot || !openSessionId) return undefined
    const plan = planForSession(snapshot, openSessionId)
    return plan ? planSummary(plan) : undefined
  }, [openSessionId, snapshot])

  const offeredSkills = useMemo(
    () => selectableTurnSkills(
      skillCatalog ?? [],
      snapshot?.skillEnablements ?? [],
      snapshot?.project?.id,
    ),
    [skillCatalog, snapshot],
  )

  const skillDescriptions = useMemo(
    () => new Map((skillCatalog ?? []).map((skill) => [skill.id, skill.description])),
    [skillCatalog],
  )

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true)
    setSkillProblem("")
    try {
      setSkillCatalog(skillSummariesSchema.parse(await call("skill.list", {})))
    } catch (cause) {
      setSkillProblem(cause instanceof Error ? cause.message : "The skill catalog could not be read")
    } finally {
      setSkillsLoading(false)
    }
  }, [call])

  const loadFleet = useCallback(() => fleetLoads.load(call), [call, fleetLoads])

  // Enablements ride the snapshot, so the phone is told the moment one changes
  // and never has to poll. What it cannot learn that way is the name of a skill
  // it has never seen, so the catalog is asked for again only when the snapshot
  // names an enabled skill this catalog does not describe.
  const catalogIncomplete = useMemo(
    () => enabledSkillsMissingFromCatalog(
      skillCatalog ?? [],
      snapshot?.skillEnablements ?? [],
      snapshot?.project?.id,
    ).length > 0,
    [skillCatalog, snapshot],
  )

  // The catalog is asked for when the picker is opened, for the same reason the
  // fleet is: a phone should not hold what it is not showing. A reconnect drops
  // what was read on the old connection, because a daemon that restarted may be
  // serving a different project entirely.
  useEffect(() => {
    if (status === "open") return
    setSkillCatalog(undefined)
  }, [status])

  useEffect(() => {
    if (!skillsOpen || status !== "open" || skillsLoading) return
    if (skillCatalog && !catalogIncomplete) return
    void loadSkills()
  }, [catalogIncomplete, loadSkills, skillCatalog, skillsLoading, skillsOpen, status])

  // The list is asked for when the tab is opened rather than polled. After that
  // the daemon pushes every change on its own, so nothing here has to ask again
  // to stay current. Depending on the status is what makes it ask once more
  // when the connection comes back.
  useEffect(() => {
    if (tab === "machines" && status === "open") void loadFleet()
  }, [loadFleet, status, tab])

  // Sessions measures how long an approval has waited and Fleet measures how
  // long a machine has been silent, so the clock ticks for both and stops on
  // the tab that reads no ages.
  useEffect(() => {
    if (tab !== "sessions" && tab !== "machines") return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [tab])

  // A failure recorded against a connection that has since dropped says nothing
  // about the fleet, and leaving it up tells the person something that is no
  // longer true. The same goes for a list still out on that connection: its
  // answer is retired here, and a new daemon passes through connecting before
  // it is open, so nothing read on the old one can land on the new one.
  useEffect(() => {
    if (status === "open") return
    fleetLoads.invalidate()
    setFleetLoading(false)
    setFleetProblem("")
  }, [fleetLoads, status])

  useEffect(() => () => fleetLoads.invalidate(), [fleetLoads])

  // The revision is the one the card on screen shows, so the daemon can refuse
  // an Allow given to a card it has since rewritten.
  const resolveApproval = async (
    approval: Pick<WorkspaceSnapshot["approvals"][number], "id" | "revision">,
    decision: ApprovalDecision,
    explanation?: string,
  ) => {
    setDeciding(true)
    setDecideProblem("")
    try {
      await mutate("approval.resolve", {
        approvalId: approval.id,
        decision,
        ...(explanation ? { explanation } : {}),
        revision: approval.revision,
      })
      setExplaining(false)
      setOpenApprovalId(undefined)
    } catch (cause) {
      // The gate is still waiting on the machine; a client that could not
      // answer it has not changed it. The screen stays and says why.
      setDecideProblem(decisionProblem(cause))
    } finally {
      setDeciding(false)
    }
  }

  const decide = async (decision: ApprovalDecision, explanation?: string) => {
    if (!openApproval) return
    await resolveApproval(openApproval, decision, explanation)
  }

  // The edit is built against the plan in the snapshot the phone holds now.
  // The daemon answers with a receipt that says whether it applied, queued or
  // conflicted, and the next snapshot carries the plan's own account of it.
  const editPlanStep = async (sessionId: string, stepId: string, text: string) => {
    const plan = snapshot ? planForSession(snapshot, sessionId) : undefined
    if (!plan) return
    const edit = planStepEdit(plan, stepId, text)
    await mutate("plan.edit", {
      sessionId,
      basedOnStructureRevision: edit.basedOnStructureRevision,
      baseSteps: edit.baseSteps,
      draftSteps: edit.draftSteps,
      ...(edit.replacesPendingEditId ? { replacesPendingEditId: edit.replacesPendingEditId } : {}),
      client,
    })
  }

  // A comment on a render is a reference to an element, coordinates plus
  // text. The daemon answers with the snapshot that carries it; the phone
  // waits for that rather than drawing a comment it has not been given.
  const commentOnElement = async (artifactId: string, anchor: PreviewSelection["anchor"], body: string) => {
    const artifact = snapshot ? findArtifact(snapshot, artifactId) : undefined
    if (!artifact) return
    await mutate("annotation.create", {
      sessionId: artifact.sessionId,
      artifactId,
      ...(artifact.variant ? { variantId: artifact.variant.id } : {}),
      anchor,
      body,
      client,
    })
  }

  // A start from a phone is two calls the credential already has: create the
  // session with the source's runtime and the chosen mode, then send the
  // words. The created session is the snapshot's active one, and the phone
  // opens it so the person lands where the work is.
  const [starting, setStarting] = useState(false)
  const [startProblem, setStartProblem] = useState("")
  const startLike = async (sessionId: string, prompt: string, mode: PermissionMode) => {
    const like = snapshot?.sessions.find((session) => session.id === sessionId)
    if (!like) return
    setStarting(true)
    setStartProblem("")
    try {
      const request = startLikeRequest(like, prompt, mode)
      const created = workspaceSnapshotSchema.parse(await mutate("session.create", {
        title: request.title,
        runtime: request.runtime,
        client,
      }))
      const startedId = created.activeSessionId
      if (!startedId) throw new Error("The daemon created the session but did not say which")
      await mutate("session.send", { sessionId: startedId, prompt: request.prompt, client })
      setOpenSessionId(startedId)
      setOpenArtifactId(undefined)
      setDraft("")
      setSendProblem("")
      setAttachments([])
      setAttachProblem("")
    } catch (cause) {
      setStartProblem(cause instanceof Error ? cause.message : "The session was not started")
    } finally {
      setStarting(false)
    }
  }

  const pauseSession = async (sessionId: string) => {
    setPausing(true)
    try {
      await mutate("session.pause", { sessionId, client })
    } finally {
      setPausing(false)
    }
  }

  const startFresh = async (prompt: string) => {
    if (!snapshot) return
    setFreshStarting(true)
    setFreshProblem("")
    try {
      const sessionId = await startFreshSession(snapshot, prompt, mutate, client)
      setFreshOpen(false)
      setOpenSessionId(sessionId)
    } catch (cause) {
      setFreshProblem(cause instanceof Error ? cause.message : "The session was not started")
    } finally {
      setFreshStarting(false)
    }
  }

  const cancelQueuedSend = async (sessionId: string, queueId: string) => {
    const queued = snapshot?.queuedSends?.find((candidate) => candidate.sessionId === sessionId)
    const params = queuedCancelParams(queued, sessionId, queueId, client)
    if (!params) return
    await mutate("session.cancelQueuedSend", params)
  }

  const refreshWorkspace = async () => {
    setRefreshing(true)
    try {
      await refresh()
    } catch {
      // The banner already says the connection is down, and a second sentence
      // saying the same thing is noise on a phone.
    } finally {
      setRefreshing(false)
    }
  }

  const sendMessage = async (sessionId: string) => {
    if (inFlightSend.current) return
    const problem = promptProblem(draft)
    if (problem) {
      setSendProblem(problem)
      return
    }
    const { selection, missing } = turnSkillSelectionFor(chosenSkills, offeredSkills)
    // A chosen skill the catalog no longer offers must stop the send. Sending
    // the smaller selection would quietly turn a request for three skills into
    // a request for two, and the daemon would accept it without complaint.
    const dropped = missingSkillProblem(missing)
    if (dropped) {
      setSendProblem(dropped)
      return
    }
    // The plus was offered on a hello that said yes; the connection may have
    // been replaced since by one that did not. The daemon would refuse the
    // whole send, so say so here rather than after the bytes went.
    if (attachments.length > 0 && !imageAttachments) {
      setSendProblem("This daemon does not take images. Remove them to send the words.")
      return
    }
    inFlightSend.current = true
    setSending(true)
    setSendProblem("")
    try {
      const session = snapshot?.sessions.find((candidate) => candidate.id === sessionId)
      await mutate("session.send", {
        sessionId,
        prompt: draft.trim(),
        client,
        ...(session ? sendDelivery(session) : {}),
        ...(selection ? { skillSelection: selection } : {}),
        ...(attachments.length > 0
          ? { attachments: attachments.map(({ mimeType, width, height, data }) => ({ mimeType, width, height, data })) }
          : {}),
      })
      setDraft("")
      setAttachments([])
    } catch (cause) {
      const refusal = turnSkillRefusalFrom(cause)
      const refusedImage = attachmentRefusalMessage(cause)
      if (refusal) setSendProblem(refusalMessage(refusal))
      else if (refusedImage) setSendProblem(refusedImage)
      else setSendProblem(cause instanceof Error ? cause.message : "The message was not sent")
    } finally {
      inFlightSend.current = false
      setSending(false)
    }
  }

  // An approval is the reason the phone exists, so it takes the whole screen
  // and the tab bar goes away until it is answered or dismissed.
  if (openApproval && (!tablet || explaining)) {
    return (
      <SafeAreaProvider>
        <SafeAreaView className="flex-1 bg-background">
          {explaining && clientAccess !== "watching" ? (
            <DenyExplainScreen
              approval={openApproval}
              pending={deciding}
              onSend={(explanation) => void decide(explanation ? "deny-explain" : "deny", explanation)}
              onBack={() => setExplaining(false)}
            />
          ) : (
            <ApprovalScreen
              approval={openApproval}
              pending={deciding}
              notice={notice}
              problem={decideProblem}
              onDecide={(decision) => void decide(decision)}
              onDenyExplain={() => setExplaining(true)}
              onBack={() => setOpenApprovalId(undefined)}
              watching={clientAccess === "watching"}
            />
          )}
        </SafeAreaView>
      </SafeAreaProvider>
    )
  }

  // An artifact is read on top of the session it belongs to, so closing it
  // returns to the thread rather than to the list.
  if (openArtifact) {
    return (
      <SafeAreaProvider>
        <SafeAreaView className="flex-1 bg-background">
          <ArtifactScreen
            artifact={openArtifact}
            notice={notice}
            comments={openArtifactComments}
            render={previewRender}
            variants={openVariants}
            machine={snapshot?.machine.name ?? "the machine"}
            onBack={() => setOpenArtifactId(undefined)}
            onRetryRender={() => setRenderAttempt((attempt) => attempt + 1)}
            onOpenVariant={setOpenArtifactId}
            onComment={(anchor, body) => commentOnElement(openArtifact.id, anchor, body)}
          />
        </SafeAreaView>
      </SafeAreaProvider>
    )
  }

  if (tablet && snapshot && tab === "sessions") {
    return (
      <SafeAreaProvider>
        <SafeAreaView edges={["top", "left", "right", "bottom"]} className="flex-1 bg-background">
          <TabletShell
            snapshot={snapshot}
            notice={notice}
            selectedSessionId={openSessionId ?? snapshot.activeSessionId ?? undefined}
            draft={draft}
            access={clientAccess}
            sending={sending || deciding}
            onSelectSession={(sessionId) => {
              setOpenSessionId(sessionId)
              setOpenApprovalId(undefined)
              setDraft("")
              setSendProblem("")
            }}
            onNewSession={() => {
              setFreshProblem("")
              setFreshOpen(true)
            }}
            onOpenMachines={() => selectTab("machines")}
            onChangeDraft={(next) => {
              setDraft(next)
              if (sendProblem) setSendProblem("")
            }}
            onSend={(sessionId) => void sendMessage(sessionId)}
            onResolve={(approvalId, decision, revision) => {
              const approval = snapshot.approvals.find((candidate) => candidate.id === approvalId)
              if (approval) void resolveApproval({ id: approval.id, revision }, decision)
            }}
            onDenyExplain={(approvalId) => {
              setOpenApprovalId(approvalId)
              setExplaining(true)
            }}
            onPostReview={(artifactId, body) => commentOnElement(artifactId, { cssSelector: "body" }, body)}
          />
          <FreshSessionSheet
            open={freshOpen}
            project={snapshot.project?.name ?? snapshot.project?.path ?? "the open project"}
            starting={freshStarting}
            problem={freshProblem}
            onStart={(prompt) => void startFresh(prompt)}
            onClose={() => { if (!freshStarting) setFreshOpen(false) }}
          />
        </SafeAreaView>
      </SafeAreaProvider>
    )
  }

  if (openSession) {
    return (
      <SafeAreaProvider>
        <SafeAreaView edges={["top", "left", "right"]} className="flex-1 bg-background">
          <SessionScreen
            detail={{ ...openSession, sending: sendReadinessOverSocket(status, openSession.sending) }}
            notice={notice}
            artifacts={openArtifacts}
            plan={openPlan}
            pausing={pausing}
            draft={draft}
            sending={sending}
            sendProblem={sendProblem}
            skillLabel={skillSelectionLabel(chosenSkills)}
            access={clientAccess}
            onWatchReceipt={watchReceipt}
            onCancelQueuedSend={(queueId) => void cancelQueuedSend(openSession.id, queueId)}
            onComposerFocusChange={setComposerFocused}
            composerBottomInset={!composerFocused && tabFootprint > 0 ? tabFootprint + 8 : undefined}
            onBack={() => {
              setOpenSessionId(undefined)
              setOpenArtifactId(undefined)
              setSendProblem("")
              setAttachments([])
              setAttachProblem("")
            }}
            onOpenApproval={setOpenApprovalId}
            onOpenArtifact={setOpenArtifactId}
            onPause={() => setConfirmPauseSession(true)}
            onChangeDraft={(next) => {
              setDraft(next)
              if (sendProblem) setSendProblem("")
            }}
            onSend={() => void sendMessage(openSession.id)}
            onOpenSkills={() => setSkillsOpen(true)}
            onEditStep={(stepId, text) => editPlanStep(openSession.id, stepId, text)}
            planPinned={!unpinnedPlans.has(openSession.id)}
            onPinPlan={(pinned) => pinPlan(openSession.id, pinned)}
            machine={snapshot?.machine.name ?? "the machine"}
            attachments={attachments}
            attachmentSummary={attachmentSummary(attachments, snapshot?.machine.name ?? "the machine")}
            attachmentsAllowed={imageAttachments}
            attachProblem={attachProblem}
            onPickLibrary={() => void pickImage("library")}
            onTakePhoto={() => void pickImage("camera")}
            onRemoveAttachment={(index) => setAttachments((current) => current.filter((_item, at) => at !== index))}
            starting={starting}
            startProblem={startProblem}
            onStartLike={(prompt, mode) => void startLike(openSession.id, prompt, mode)}
          />
          <SkillSheet
            open={skillsOpen}
            rows={skillPickerRows(offeredSkills, chosenSkills, skillDescriptions)}
            chosen={chosenSkills !== undefined}
            loading={skillsLoading}
            problem={skillProblem}
            onToggle={(skillId) => {
              setChosenSkills((current) => {
                const next = new Set(current ?? [])
                if (next.has(skillId)) next.delete(skillId)
                else next.add(skillId)
                return next
              })
              if (sendProblem) setSendProblem("")
            }}
            onUseDefault={() => {
              setChosenSkills(undefined)
              if (sendProblem) setSendProblem("")
            }}
            onClose={() => setSkillsOpen(false)}
          />
          <ConfirmSheet
            open={confirmPauseSession}
            title="Pause this session?"
            detail="This stops the turn the agent is running now. Work already done is kept, and the session has to be started again by hand."
            confirmLabel="Pause this session"
            onConfirm={() => {
              setConfirmPauseSession(false)
              void pauseSession(openSession.id)
            }}
            onCancel={() => setConfirmPauseSession(false)}
          />
          {!composerFocused ? (
            <TabBar
              active="sessions"
              waiting={waiting}
              onSelect={(next) => {
                if (next === "sessions") return
                setOpenSessionId(undefined)
                selectTab(next)
              }}
              onFootprint={setTabFootprint}
            />
          ) : null}
        </SafeAreaView>
      </SafeAreaProvider>
    )
  }

  if (pairingMode) {
    return (
      <SafeAreaProvider>
        <SafeAreaView className="flex-1 bg-background">
          <PairScanScreen
            mode={pairingMode}
            permission={cameraPermission}
            requestPermission={requestCameraPermission}
            device={tablet ? "tablet" : "phone"}
            onPaired={(credential) => {
              setUrl(credential.url)
              setToken(credential.token)
              setConnectTo(credential)
              void saveCredential(credential)
            }}
            // The paired card stays up until the person moves on, so the line
            // about when a gate can reach this device is read, not flashed.
            onDone={() => {
              setPairingMode(undefined)
              selectTab("sessions")
            }}
            onCancel={() => setPairingMode(undefined)}
          />
        </SafeAreaView>
      </SafeAreaProvider>
    )
  }

  return (
    <SafeAreaProvider>
      {/* The tab bar floats over the screen rather than sitting under it, so
          this view does not reserve the bottom edge. What the bar covers is
          measured and handed to each screen, which pads its own scroller. */}
      <SafeAreaView edges={["top", "left", "right"]} className="flex-1 bg-background">
        <View className="flex-1">
          {tab === "sessions" ? (
            unpaired ? (
              <UnpairedScreen
                tab="sessions"
                bottomInset={tabFootprint}
                onPair={() => selectTab("machines")}
              />
            ) : snapshot ? (
              <SessionsScreen
                snapshot={snapshot}
                fleet={fleet}
                notice={notice}
                refreshing={refreshing}
                now={now}
                onOpenApproval={setOpenApprovalId}
                onRefresh={() => void refreshWorkspace()}
                onStartSession={() => {
                  setFreshProblem("")
                  setFreshOpen(true)
                }}
                startDisabledReason={clientAccess === "watching"
                  ? watchingReason
                  : freshReadiness?.canStart === false ? freshReadiness.reason : undefined}
                onOpenSession={(sessionId) => {
                  // A draft is written for one session. Carrying it into
                  // another one would let a reply meant for one agent start a
                  // turn on a different one.
                  if (sessionId !== openSessionId) {
                    setDraft("")
                    setSendProblem("")
                    // Same for what was picked to go with it.
                    setAttachments([])
                    setAttachProblem("")
                  }
                  setOpenSessionId(sessionId)
                }}
                bottomInset={tabFootprint}
              />
            ) : unreachable ? (
              <ShellNotice
                shell={unreachable}
                phases={phases}
                address={connectTo?.url ?? ""}
                bottomInset={tabFootprint}
                 onOpenSettings={() => selectTab("settings")}
                onRetry={reconnect}
              />
            ) : null
          ) : null}
          {tab === "machines" ? (
            unpaired ? (
              <UnpairedScreen
                tab="machines"
                bottomInset={tabFootprint}
                onPair={() => setPairingMode("scan")}
                onScanPairingCode={() => setPairingMode("scan")}
                onTypePairingCode={() => setPairingMode("type")}
              />
            ) : (
            <MachinesScreen
              fleet={fleet}
              activity={activity}
              loading={fleetLoading}
              problem={fleetProblem}
              notice={notice}
              connected={status === "open"}
              now={now}
              onRefresh={() => void loadFleet()}
              onOpen={() => selectTab("sessions")}
              onScanPairingCode={() => setPairingMode("scan")}
              onTypePairingCode={() => setPairingMode("type")}
              bottomInset={tabFootprint}
            />
            )
          ) : null}
          {tab === "settings" ? (
            <SettingsScreen
              url={url}
              token={token}
              status={status}
              fault={fault}
              onChangeUrl={setUrl}
              onChangeToken={setToken}
              onConnect={() => {
                // A typed token carries no kind; the connection finds it out.
                const next = { url: url.trim(), token: token.trim(), client: undefined }
                setConnectTo(next)
                void saveCredential(next)
              }}
              onForget={() => {
                setConnectTo(undefined)
                setUrl("")
                setToken("")
                void clearCredential()
              }}
              onOpenStop={() => setConfirmPause(true)}
              themePreference={preference}
              onChangeTheme={setPreference}
              paired={!unpaired}
              device={tablet ? "tablet" : "phone"}
              bottomInset={tabFootprint}
            />
          ) : null}
        </View>
        <FreshSessionSheet
          open={freshOpen}
          project={snapshot?.project?.name ?? snapshot?.project?.path ?? "the open project"}
          starting={freshStarting}
          problem={freshProblem}
          onStart={(prompt) => void startFresh(prompt)}
          onClose={() => {
            if (!freshStarting) setFreshOpen(false)
          }}
        />
        <TabBar
          active={tab}
          waiting={waiting}
          onSelect={selectTab}
          onFootprint={setTabFootprint}
        />
        <StopSheet
          open={confirmPause}
          onOpenStop={() => {
            setConfirmPause(false)
            void mutate("system.pauseAll", { client })
          }}
          onEmergencyStop={() => {
            setConfirmPause(false)
            void mutate("system.emergencyStop", { client })
          }}
          onCancel={() => setConfirmPause(false)}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  )
}
