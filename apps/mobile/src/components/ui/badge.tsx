import { View } from "react-native"

import { cn } from "../../lib/cn"
import { Text } from "./text"

type Tone =
  | "neutral"
  | "outline"
  | "attention"
  | "primary"
  | "success"
  | "warning"
  | "destructive"

// Every chip in the handoff is machine text: a model name, a mode, a transport,
// a state. They are small, tight and set in mono, and the ones that carry a
// warning are the only ones that gain a border.
const tones: Record<Tone, { box: string, label: string }> = {
  neutral: { box: "bg-muted", label: "text-strong" },
  outline: { box: "border border-border", label: "text-muted-foreground" },
  attention: { box: "bg-primary/20", label: "text-primary" },
  primary: { box: "border border-primary", label: "text-primary" },
  success: { box: "border border-border", label: "text-success" },
  warning: { box: "border border-warn-border", label: "text-warning" },
  destructive: { box: "bg-muted", label: "text-destructive" },
}

export function Badge({
  label,
  tone = "neutral",
  pill = false,
}: {
  label: string
  tone?: Tone
  // The approval header wears its risk as a pill rather than a chip, because it
  // is the one badge on that screen rather than one of a row.
  pill?: boolean
}) {
  const style = tones[tone]
  return (
    <View className={cn(
      "self-start",
      pill ? "rounded-full px-[7px] py-[3px]" : "rounded-[4px] px-[5px] py-0.5",
      style.box,
    )}>
      <Text className={cn(
        "font-mono uppercase tracking-[0.06em]",
        pill ? "text-[9.5px]" : "text-[9px]",
        style.label,
      )}>
        {label}
      </Text>
    </View>
  )
}
