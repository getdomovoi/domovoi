import { View } from "react-native"

import { cn } from "../../lib/cn"
import { Text } from "./text"

type Tone = "neutral" | "primary" | "success" | "warning" | "destructive"

const tones: Record<Tone, { box: string, label: string }> = {
  neutral: { box: "border-border bg-accent", label: "text-muted-foreground" },
  primary: { box: "border-primary bg-transparent", label: "text-primary" },
  success: { box: "border-success bg-transparent", label: "text-success" },
  warning: { box: "border-warn-border bg-warn-bg", label: "text-warn-fg" },
  destructive: { box: "border-destructive bg-transparent", label: "text-destructive" },
}

export function Badge({ label, tone = "neutral" }: { label: string, tone?: Tone }) {
  const style = tones[tone]
  return (
    <View className={cn("self-start rounded-xl border px-1.5 py-0.5", style.box)}>
      <Text className={cn("font-mono text-[10px] uppercase tracking-[0.06em]", style.label)}>
        {label}
      </Text>
    </View>
  )
}
