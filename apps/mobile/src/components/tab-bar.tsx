import { Pressable, View } from "react-native"

import { cn } from "../lib/cn"
import { FloatingBar } from "./floating-bar"
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
  onFootprint,
}: {
  active: Tab
  // Approvals are the reason to pick the phone up, so the count rides the tab
  // rather than waiting to be discovered on the screen behind it.
  waiting: number
  onSelect: (tab: Tab) => void
  // The list scrolls underneath this bar, so the list has to be told how much
  // of its own bottom the bar is covering.
  onFootprint?: (footprint: number) => void
}) {
  return (
    <FloatingBar testID="tab-bar" padding="tabs" onFootprint={onFootprint}>
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
            // The handoff draws a 52pt bar and four 44pt targets do not fit
            // inside one. The drawn tab keeps the size it is drawn at and the
            // target is grown past it instead, so the bar reads right and a
            // thumb still lands where iOS asks it to.
            hitSlop={{ top: 9, bottom: 9 }}
            className="flex-1 items-center gap-[3px] px-1 py-0.5"
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
    </FloatingBar>
  )
}
