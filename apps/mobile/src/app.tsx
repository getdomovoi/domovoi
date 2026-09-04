import { useEffect, useMemo, useState } from "react"
import { View } from "react-native"
import { StatusBar } from "expo-status-bar"
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context"
import type { ApprovalDecision } from "@getdomovoi/protocol"

import { TabBar, type Tab } from "./components/tab-bar"
import { Text } from "./components/ui/text"
import { clearCredential, loadCredential, saveCredential } from "./lib/credentials"
import { useDaemon } from "./lib/use-daemon"
import { ApprovalScreen } from "./screens/approval"
import { FleetScreen } from "./screens/fleet"
import { SessionsScreen } from "./screens/sessions"
import { SettingsScreen } from "./screens/settings"
import { waitingCount } from "./session-rows"
import "./global.css"

export function App() {
  const [tab, setTab] = useState<Tab>("sessions")
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [connectTo, setConnectTo] = useState<{ url: string, token: string } | undefined>(undefined)
  const [restoring, setRestoring] = useState(true)
  const [openApprovalId, setOpenApprovalId] = useState<string | undefined>(undefined)
  const [deciding, setDeciding] = useState(false)

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

  const decide = async (decision: ApprovalDecision) => {
    if (!openApproval) return
    setDeciding(true)
    try {
      await call("approval.resolve", {
        approvalId: openApproval.id,
        decision,
        client: "phone",
      })
      setOpenApprovalId(undefined)
    } finally {
      setDeciding(false)
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

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1">
          {tab === "sessions" ? (
            snapshot ? (
              <SessionsScreen
                snapshot={snapshot}
                machineCount={1}
                onOpenSession={(sessionId) => {
                  const next = snapshot.approvals.find((approval) => approval.sessionId === sessionId)
                  if (next) setOpenApprovalId(next.id)
                }}
                onPauseAll={() => { void call("system.emergencyStop", { client: "phone" }) }}
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
          {tab === "fleet" ? <FleetScreen fleet={[]} /> : null}
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
      </SafeAreaView>
    </SafeAreaProvider>
  )
}
