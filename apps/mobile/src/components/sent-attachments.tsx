import type { SentAttachmentChip } from "@getdomovoi/protocol"
import { View } from "react-native"

import { cn } from "../lib/cn"
import { Text } from "./ui/text"

// What a sent message carried, under it, in the composer's attachment row
// read only (walk finding F26). The phone keeps no copy of a sent image and
// the daemon keeps none either, so each is named by kind and size rather
// than drawn. One chip is one accessible element, read as one sentence.
export function SentAttachments({ attachments, className }: {
  attachments: readonly SentAttachmentChip[] | undefined
  className?: string
}) {
  if (!attachments?.length) return null
  return (
    <View className={cn("items-end gap-1.5 self-end", className)}>
      {attachments.map((chip, index) => (
        <View
          key={`${chip.kind}-${index}`}
          accessible
          accessibilityLabel={chip.label}
          className="max-w-full flex-row items-center gap-2 rounded-lg border border-border bg-code px-2.5 py-1.5"
        >
          <Text variant="machine" className="text-muted-foreground">{chip.mark}</Text>
          <Text variant="machine" className="shrink text-strong" numberOfLines={1}>{chip.name}</Text>
          <Text variant="machine" className="text-faint" numberOfLines={1}>{chip.meta}</Text>
        </View>
      ))}
    </View>
  )
}
