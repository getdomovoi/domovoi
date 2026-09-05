import { Pressable, View } from "react-native"

import { cn } from "../lib/cn"
import { Text } from "./ui/text"

export type Tab = "sessions" | "fleet" | "settings"

const tabs: Array<{ id: Tab, label: string, glyph: string }> = [
  { id: "sessions", label: "Sessions", glyph: "▤" },
  { id: "fleet", label: "Fleet", glyph: "◈" },
  { id: "settings", label: "Settings", glyph: "⚙" },
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
  return (
    <View className="flex-row border-t border-border bg-sidebar pb-1">
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
            className="min-h-tap flex-1 items-center justify-center gap-0.5 py-2"
          >
            <View className="flex-row items-center gap-1">
              <Text className={cn("text-[15px]", selected ? "text-primary" : "text-faint")}>
                {tab.glyph}
              </Text>
              {tab.id === "sessions" && waiting > 0 ? (
                <View className="min-w-[16px] items-center rounded-full bg-warning px-1">
                  <Text className="text-[10px] font-sans-semibold text-background">{waiting}</Text>
                </View>
              ) : null}
            </View>
            <Text className={cn("text-[10px]", selected ? "text-primary" : "text-faint")}>
              {tab.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
