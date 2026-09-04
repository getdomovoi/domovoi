import { useCallback, useEffect, useMemo, useState } from "react"
import { View } from "react-native"
import { StatusBar } from "expo-status-bar"
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context"
import { fleetSnapshotSchema, type ApprovalDecision, type FleetMachine } from "@getdomovoi/protocol"

import { ConfirmSheet } from "./components/confirm-sheet"
import { TabBar, type Tab } from "./components/tab-bar"
import { Text } from "./components/ui/text"
import { clearCredential, loadCredential, saveCredential } from "./lib/credentials"
import { clientKind } from "./lib/protocol-facts"
import { useDaemon } from "./lib/use-daemon"
import { planForSession, planSummary } from "./plan-rows"
import { ApprovalScreen } from "./screens/approval"
import { FleetScreen } from "./screens/fleet"
import { SessionScreen } from "./screens/session"
import { SessionsScreen } from "./screens/sessions"
import { SettingsScreen } from "./screens/settings"
import { sessionDetail } from "./session-detail"
import { waitingCount } from "./session-rows"
import "./global.css"

export function App() {
  const [tab, setTab] = useState<Tab>("sessions")
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [connectTo, setConnectTo] = useState<{ url: string, token: string } | undefined>(undefined)
  const [restoring, setRestoring] = useState(true)
  const [openApprovalId, setOpenApprovalId] = useState<string | undefined>(undefined)
  const [openSessionId, setOpenSessionId] = useState<string | undefined>(undefined)
  const [deciding, setDeciding] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [confirmPauseSession, setConfirmPauseSession] = useState(false)
  const [fleet, setFleet] = useState<FleetMachine[] | undefined>(undefined)
  const [fleetLoading, setFleetLoading] = useState(false)
  const [fleetProblem, setFleetProblem] = useState("")
  const [confirmPause, setConfirmPause] = useState(false)

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

  const { snapshot, status, problem, call } = useDaemon(connectTo?.url, connectTo?.token)
  const waiting = snapshot ? waitingCount(snapshot) : 0

  const openApproval = useMemo(
    () => snapshot?.approvals.find((approval) => approval.id === openApprovalId),
    [openApprovalId, snapshot],
  )

  const openSession = useMemo(
    () => snapshot && openSessionId ? sessionDetail(snapshot, openSessionId) : undefined,
    [openSessionId, snapshot],
  )

  const openPlan = useMemo(() => {
    if (!snapshot || !openSessionId) return undefined
    const plan = planForSession(snapshot, openSessionId)
    return plan ? planSummary(plan) : undefined
  }, [openSessionId, snapshot])

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

  // The list is asked for when the tab is opened rather than kept warm, because
  // a phone should not hold a subscription it is not showing.
  useEffect(() => {
    if (tab === "fleet" && status === "open") void loadFleet()
  }, [loadFleet, status, tab])

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

  // A session is read the same way: full screen, back to the list, no tab bar
  // competing with the thread for the bottom of a phone.
  if (openSession) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <SafeAreaView className="flex-1 bg-background">
          <SessionScreen
            detail={openSession}
            plan={openPlan}
            pausing={pausing}
            onBack={() => setOpenSessionId(undefined)}
            onOpenApproval={setOpenApprovalId}
            onPause={() => setConfirmPauseSession(true)}
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
                onOpenSession={setOpenSessionId}
                onPauseAll={() => setConfirmPause(true)}
              />
            ) : (
              <View className="flex-1 items-center justify-center gap-2 p-6">
                <Text variant="title">Not connected</Text>
                <Text variant="meta" className="text-center">
                  {restoring
                    ? "Looking for a saved daemon."
                    : "Add your daemon address and pairing token in Settings."}
                </Text>
              </View>
            )
          ) : null}
          {tab === "fleet" ? (
            <FleetScreen
              fleet={fleet}
              loading={fleetLoading}
              problem={fleetProblem}
              onRefresh={() => void loadFleet()}
            />
          ) : null}
          {tab === "settings" ? (
            <SettingsScreen
              url={url}
              token={token}
              status={status}
              problem={problem}
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
