import { useEffect, useState } from "react"
import { View } from "react-native"
import { useFonts } from "expo-font"

import { App } from "./app"
import { drawWithFonts, fontWaitLimitMs } from "./theme/font-gate"
import { fontSources } from "./theme/fonts"
import { colors } from "./theme/tokens.generated"

// Nothing draws until the faces are registered, otherwise the first frame
// renders in the platform font and swaps a moment later. The wait is bounded:
// a face that fails or stalls lets the app through on the platform font
// instead of holding a blank screen.
export function Root() {
  const [loaded, error] = useFonts(fontSources)
  const [waitedOut, setWaitedOut] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setWaitedOut(true), fontWaitLimitMs)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (error) console.warn(`fonts did not load, drawing with the platform face: ${error.message}`)
  }, [error])

  if (!drawWithFonts({ loaded, failed: error !== null, waitedOut })) {
    return <View style={{ flex: 1, backgroundColor: colors.dark.background }} />
  }
  return <App />
}
