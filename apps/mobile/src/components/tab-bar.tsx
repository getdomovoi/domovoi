import { Pressable, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { cn } from "../lib/cn"
import { Icon, type IconName } from "./ui/icon"
import { Text } from "./ui/text"

export type Tab = "sessions" | "review" | "fleet" | "settings"

const tabs: Array<{ id: Tab, label: string, icon: IconName }> = [
  { id: "sessions", label: "Sessions", icon: "layers" },
  { id: "review", label: "Review", icon: "eye" },
  { id: "fleet", label: "Fleet", icon: "server" },
  { id: "settings", label: "Settings", icon: "settings" },
]

export function TabBar({
  active,
  waiting,
  onSelect,
}: {
  active: Tab
  // Approvals are the reason to pick the phone up, so the count rides the tab
  // rather than waiting to be discovered on the screen behind it.
  waiting: number
  onSelect: (tab: Tab) => void
}) {
  const insets = useSafeAreaInsets()
  return (
    // The bar runs to the bottom edge so the sidebar fill reaches it, with the
    // home indicator sitting over the bar rather than over the page behind it.
    // Where the device reserves nothing, the design's own bottom padding stands in.
    <View
      className="flex-row items-start border-t border-border bg-sidebar pt-2"
      style={{ paddingBottom: insets.bottom > 0 ? insets.bottom : 10 }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={tab.id === "sessions" && waiting > 0
              ? `Sessions, ${waiting} waiting`
              : tab.label}
            onPress={() => onSelect(tab.id)}
            className="min-h-tap flex-1 items-center gap-[3px] px-1 py-0.5"
          >
            <View className="h-[22px] justify-center">
              <Icon name={tab.icon} tone={selected ? "primary" : "faint"} />
              {tab.id === "sessions" && waiting > 0 ? (
                <View className="absolute -right-2 -top-0.5 min-w-[15px] items-center rounded-full bg-warning px-1">
                  <Text className="font-mono text-[9px] text-warning-foreground">{waiting}</Text>
                </View>
              ) : null}
            </View>
            <Text className={cn(
              "text-[9.5px] tracking-[0.02em]",
              selected ? "text-primary" : "text-faint",
            )}>
              {tab.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
