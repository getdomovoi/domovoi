import { StatusBar } from "expo-status-bar"
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context"
import { demoWorkspace } from "@getdomovoi/protocol"

import { SessionsScreen } from "./screens/sessions"
import "./global.css"

// The daemon connection lands next. Until it does this renders the shared demo
// workspace, so the screen is exercised against real protocol shapes rather
// than against a fixture written to flatter it.
export function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView className="flex-1 bg-background">
        <SessionsScreen
          snapshot={demoWorkspace}
          machineCount={1}
          onOpenSession={() => {}}
          onPauseAll={() => {}}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  )
}
