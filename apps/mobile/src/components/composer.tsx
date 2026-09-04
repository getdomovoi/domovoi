import { Pressable, TextInput, View } from "react-native"

import { cn } from "../lib/cn"
import type { SendReadiness } from "../session-detail"
import { Text } from "./ui/text"

export function Composer({
  draft,
  readiness,
  sending,
  problem,
  skillLabel,
  onChangeDraft,
  onSend,
  onOpenSkills,
}: {
  draft: string
  readiness: SendReadiness
  // True from the tap until the daemon answers. The button is disabled on it,
  // and the caller holds a latch as well, because two taps in one frame both
  // see the old value of this.
  sending: boolean
  problem: string
  skillLabel: string
  onChangeDraft: (draft: string) => void
  onSend: () => void
  onOpenSkills: () => void
}) {
  const blocked = !readiness.can
  const canSend = readiness.can && !sending && draft.trim().length > 0

  return (
    <View className="gap-2 border-t border-border bg-background px-3.5 py-2.5">
      {problem ? <Text className="text-[11px] text-destructive">{problem}</Text> : null}
      {readiness.can && readiness.hint
        ? <Text variant="meta" className="text-[11px]">{readiness.hint}</Text>
        : null}
      {blocked ? <Text variant="meta" className="text-[11px]">{readiness.reason}</Text> : null}

      {!blocked ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Skills for this turn: ${skillLabel}`}
          onPress={onOpenSkills}
          className="min-h-tap flex-row items-center gap-1.5 self-start active:opacity-70"
        >
          <Text variant="label">Skills</Text>
          <Text variant="machine" className="text-[10px] text-primary">{skillLabel}</Text>
        </Pressable>
      ) : null}

      <View className="flex-row items-end gap-2">
        <TextInput
          multiline
          editable={!blocked && !sending}
          value={draft}
          onChangeText={onChangeDraft}
          placeholder={blocked ? "This session cannot take a message" : "Reply…"}
          placeholderTextColor="#6b6b72"
          accessibilityLabel="Reply to this session"
          className={cn(
            "max-h-32 min-h-tap flex-1 rounded-xl border border-border bg-card px-3.5 py-3 text-[12.5px] text-foreground",
            blocked && "opacity-50",
          )}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={sending ? "Sending" : "Send"}
          accessibilityState={{ disabled: !canSend, busy: sending }}
          disabled={!canSend}
          onPress={onSend}
          className={cn(
            "min-h-tap min-w-tap items-center justify-center rounded-pill",
            canSend ? "bg-primary" : "bg-accent",
          )}
        >
          <Text className={cn(
            "text-[16px]",
            canSend ? "text-primary-foreground" : "text-faint",
          )}>
            {sending ? "···" : "↑"}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}
