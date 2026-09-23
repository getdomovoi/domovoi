import { View } from "react-native"

import type { LaunchPhase } from "../launch-state"
import { cn } from "../lib/cn"
import { Text } from "./ui/text"

const dots: Record<LaunchPhase["tone"], string> = {
  complete: "bg-success",
  active: "bg-warning",
  waiting: "bg-muted",
  failed: "bg-destructive",
}

const states: Record<LaunchPhase["tone"], string> = {
  complete: "text-faint",
  active: "text-warning",
  waiting: "text-faint",
  failed: "text-destructive",
}

export function LaunchPhases({ phases }: { phases: readonly LaunchPhase[] }) {
  return (
    <View accessibilityLabel="Launch phases" className="w-full gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3">
      {phases.map((phase) => (
        <View key={phase.label} className="flex-row items-center gap-2.5">
          <View className={cn("h-1.5 w-1.5 rounded-full", dots[phase.tone])} />
          <Text variant="machine" className="flex-1 text-strong">{phase.label}</Text>
          <Text variant="machine" className={states[phase.tone]}>{phase.state}</Text>
        </View>
      ))}
    </View>
  )
}
