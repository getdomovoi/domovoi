import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { useColorScheme, View } from "react-native"
import * as SecureStore from "expo-secure-store"
import { StatusBar } from "expo-status-bar"
import { vars } from "nativewind"

import { colors } from "./tokens.generated"
import { resolveTheme, themeColorVariables, type ResolvedTheme, type ThemePreference } from "./theme"

const preferenceKey = "domovoi.appearance"
const preferences: ReadonlySet<string> = new Set(["light", "dark", "system"])

type Palette = Record<keyof typeof colors.dark, string>

type ThemeValue = {
  preference: ThemePreference
  resolved: ResolvedTheme
  palette: Palette
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeValue>({
  preference: "system",
  resolved: "dark",
  palette: colors.dark,
  setPreference: () => {},
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme()
  const [preference, setStoredPreference] = useState<ThemePreference>("system")

  useEffect(() => {
    let live = true
    void SecureStore.getItemAsync(preferenceKey).then((stored) => {
      if (live && stored && preferences.has(stored)) setStoredPreference(stored as ThemePreference)
    })
    return () => { live = false }
  }, [])

  const resolved = resolveTheme(preference, system)
  const setPreference = (next: ThemePreference) => {
    setStoredPreference(next)
    void SecureStore.setItemAsync(preferenceKey, next)
  }
  const value = useMemo(() => ({ preference, resolved, palette: colors[resolved] as Palette, setPreference }), [preference, resolved])
  const style = vars(themeColorVariables(resolved))

  return (
    <ThemeContext.Provider value={value}>
      <StatusBar style={resolved === "dark" ? "light" : "dark"} />
      <View className="flex-1" style={style}>{children}</View>
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext)
}
