import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { View } from "react-native"
import { StatusBar } from "expo-status-bar"
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context"
import {
  fleetSnapshotSchema,
  selectableTurnSkills,
  skillSummariesSchema,
  turnSkillRefusalFrom,
  turnSkillSelectionFor,
  type ApprovalDecision,
  type FleetMachine,
  type SkillSummary,
} from "@getdomovoi/protocol"

import { artifactRows, findArtifact } from "./artifact-rows"
import { connectionNotice } from "./connection-notice"
import { ConfirmSheet } from "./components/confirm-sheet"
import { SkillSheet } from "./components/skill-sheet"
import { TabBar, type Tab } from "./components/tab-bar"
import { Text } from "./components/ui/text"
import { clearCredential, loadCredential, saveCredential } from "./lib/credentials"
import { clientKind } from "./lib/protocol-facts"
import { useDaemon } from "./lib/use-daemon"
import { planForSession, planSummary } from "./plan-rows"
import { ApprovalScreen } from "./screens/approval"
import { ArtifactScreen } from "./screens/artifact"
import { FleetScreen } from "./screens/fleet"
import { SessionScreen } from "./screens/session"
import { SessionsScreen } from "./screens/sessions"
import { SettingsScreen } from "./screens/settings"
import { promptProblem, sessionDetail } from "./session-detail"
import { shellState } from "./shell-state"
import { waitingCount } from "./session-rows"
import {
  missingSkillProblem,
  refusalMessage,
  skillPickerRows,
  skillSelectionLabel,
} from "./turn-skills"
import "./global.css"

export function App() {
  const [tab, setTab] = useState<Tab>("sessions")
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [connectTo, setConnectTo] = useState<{ url: string, token: string } | undefined>(undefined)
  const [restoring, setRestoring] = useState(true)
  const [openApprovalId, setOpenApprovalId] = useState<string | undefined>(undefined)
  const [openSessionId, setOpenSessionId] = useState<string | undefined>(undefined)
  const [openArtifactId, setOpenArtifactId] = useState<string | undefined>(undefined)
  const [deciding, setDeciding] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [confirmPauseSession, setConfirmPauseSession] = useState(false)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [sendProblem, setSendProblem] = useState("")
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
  const [fleet, setFleet] = useState<FleetMachine[] | undefined>(undefined)
  const [fleetLoading, setFleetLoading] = useState(false)
  const [fleetProblem, setFleetProblem] = useState("")
  const [confirmPause, setConfirmPause] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

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

  const { snapshot, status, fault, call, refresh } = useDaemon(connectTo?.url, connectTo?.token)
  const notice = connectionNotice(status, fault, snapshot !== undefined)
  const shell = shellState({
    restoringCredential: restoring,
    hasCredential: connectTo !== undefined,
    hasSnapshot: snapshot !== undefined,
    fault,
  })
  const waiting = snapshot ? waitingCount(snapshot) : 0

  const openApproval = useMemo(
    () => snapshot?.approvals.find((approval) => approval.id === openApprovalId),
    [openApprovalId, snapshot],
  )

  const openSession = useMemo(
    () => snapshot && openSessionId ? sessionDetail(snapshot, openSessionId) : undefined,
    [openSessionId, snapshot],
  )

  const openArtifacts = useMemo(
    () => snapshot && openSessionId ? artifactRows(snapshot, openSessionId) : [],
    [openSessionId, snapshot],
  )

  const openArtifact = useMemo(
    () => snapshot && openArtifactId ? findArtifact(snapshot, openArtifactId) : undefined,
    [openArtifactId, snapshot],
  )

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

  const loadFleet = useCallback(async () => {
    setFleetLoading(true)
    setFleetProblem("")
    try {
      const result = await call("fleet.list", { client: clientKind })
      setFleet(fleetSnapshotSchema.parse(result).machines)
    } catch (cause) {
      setFleetProblem(cause instanceof Error ? cause.message : "The fleet could not be listed")
    } finally {
      setFleetLoading(false)
    }
  }, [call])

  // The catalog is asked for when the picker is opened, for the same reason the
  // fleet is: a phone should not hold what it is not showing.
  useEffect(() => {
    if (skillsOpen && status === "open" && !skillCatalog && !skillsLoading) void loadSkills()
  }, [loadSkills, skillCatalog, skillsLoading, skillsOpen, status])

  // The list is asked for when the tab is opened rather than kept warm, because
  // a phone should not hold a subscription it is not showing. Depending on the
  // status is what makes it ask again when the connection comes back.
  useEffect(() => {
    if (tab === "fleet" && status === "open") void loadFleet()
  }, [loadFleet, status, tab])

  // A failure recorded against a connection that has since dropped says nothing
  // about the fleet, and leaving it up tells the person something that is no
  // longer true.
  useEffect(() => {
    if (status !== "open") setFleetProblem("")
  }, [status])

  const decide = async (decision: ApprovalDecision) => {
    if (!openApproval) return
    setDeciding(true)
    try {
      await call("approval.resolve", {
        approvalId: openApproval.id,
        decision,
        client: clientKind,
      })
      setOpenApprovalId(undefined)
    } finally {
      setDeciding(false)
    }
  }

  const pauseSession = async (sessionId: string) => {
    setPausing(true)
    try {
      await call("session.pause", { sessionId, client: clientKind })
    } finally {
      setPausing(false)
    }
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
    inFlightSend.current = true
    setSending(true)
    setSendProblem("")
    try {
      await call("session.send", {
        sessionId,
        prompt: draft.trim(),
        client: clientKind,
        ...(selection ? { skillSelection: selection } : {}),
      })
      setDraft("")
    } catch (cause) {
      const refusal = turnSkillRefusalFrom(cause)
      if (refusal) setSendProblem(refusalMessage(refusal))
      else setSendProblem(cause instanceof Error ? cause.message : "The message was not sent")
    } finally {
      inFlightSend.current = false
      setSending(false)
    }
  }

  // An approval is the reason the phone exists, so it takes the whole screen
  // and the tab bar goes away until it is answered or dismissed.
  if (openApproval) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <SafeAreaView className="flex-1 bg-background">
          <ApprovalScreen
            approval={openApproval}
            pending={deciding}
            onDecide={(decision) => void decide(decision)}
            onBack={() => setOpenApprovalId(undefined)}
          />
        </SafeAreaView>
      </SafeAreaProvider>
    )
  }

  // An artifact is read on top of the session it belongs to, so closing it
  // returns to the thread rather than to the list.
  if (openArtifact) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <SafeAreaView className="flex-1 bg-background">
          <ArtifactScreen
            artifact={openArtifact}
            onBack={() => setOpenArtifactId(undefined)}
          />
        </SafeAreaView>
      </SafeAreaProvider>
    )
  }

  // A session is read the same way: full screen, back to the list, no tab bar
  // competing with the thread for the bottom of a phone.
  if (openSession) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <SafeAreaView className="flex-1 bg-background">
          <SessionScreen
            detail={openSession}
            artifacts={openArtifacts}
            plan={openPlan}
            pausing={pausing}
            draft={draft}
            sending={sending}
            sendProblem={sendProblem}
            skillLabel={skillSelectionLabel(chosenSkills)}
            onBack={() => {
              setOpenSessionId(undefined)
              setOpenArtifactId(undefined)
              setSendProblem("")
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
        </SafeAreaView>
      </SafeAreaProvider>
    )
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1">
          {tab === "sessions" ? (
            snapshot ? (
              <SessionsScreen
                snapshot={snapshot}
                machineCount={fleet?.length}
                notice={notice}
                refreshing={refreshing}
                onRefresh={() => void refreshWorkspace()}
                onOpenSession={(sessionId) => {
                  // A draft is written for one session. Carrying it into
                  // another one would let a reply meant for one agent start a
                  // turn on a different one.
                  if (sessionId !== openSessionId) {
                    setDraft("")
                    setSendProblem("")
                  }
                  setOpenSessionId(sessionId)
                }}
                onPauseAll={() => setConfirmPause(true)}
              />
            ) : (
              <View className="flex-1 items-center justify-center gap-2 p-6">
                <Text variant="title">{shell.headline}</Text>
                <Text variant="meta" className="text-center">{shell.detail}</Text>
              </View>
            )
          ) : null}
          {tab === "fleet" ? (
            <FleetScreen
              fleet={fleet}
              loading={fleetLoading}
              problem={fleetProblem}
              notice={notice}
              connected={status === "open"}
              onRefresh={() => void loadFleet()}
            />
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
                const next = { url: url.trim(), token: token.trim() }
                setConnectTo(next)
                void saveCredential(next)
              }}
              onForget={() => {
                setConnectTo(undefined)
                setUrl("")
                setToken("")
                void clearCredential()
              }}
            />
          ) : null}
        </View>
        <TabBar active={tab} waiting={waiting} onSelect={setTab} />
        <ConfirmSheet
          open={confirmPause}
          title="Pause every session?"
          detail="This stops every running agent on the machine at once. Work already done is kept, and each session has to be started again by hand."
          confirmLabel="Pause all sessions"
          onConfirm={() => {
            setConfirmPause(false)
            void call("system.emergencyStop", { client: clientKind })
          }}
          onCancel={() => setConfirmPause(false)}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  )
}
