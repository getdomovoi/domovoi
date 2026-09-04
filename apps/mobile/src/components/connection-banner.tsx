import type { ConnectionNotice } from "../connection-notice"
import { cn } from "../lib/cn"
import { Card } from "./ui/card"
import { Text } from "./ui/text"

const tones: Record<ConnectionNotice["tone"], { box: string, headline: string, detail: string }> = {
  warning: {
    box: "border-warn-border bg-warn-bg",
    headline: "text-warn-fg",
    detail: "text-warn-dim",
  },
  destructive: {
    box: "border-destructive bg-card",
    headline: "text-destructive",
    detail: "text-muted-foreground",
  },
}

export function ConnectionBanner({ notice }: { notice: ConnectionNotice | undefined }) {
  if (!notice) return null
  const tone = tones[notice.tone]
  return (
    <Card className={cn("gap-1", tone.box)} accessibilityRole="alert">
      <Text className={cn("text-[13px] font-sans-semibold", tone.headline)}>{notice.headline}</Text>
      <Text className={cn("text-[11px] leading-4", tone.detail)}>{notice.detail}</Text>
    </Card>
  )
}
