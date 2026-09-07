import { Pressable, TextInput, View } from "react-native"

import { cn } from "../lib/cn"
import { FloatingBar } from "./floating-bar"
import { colors } from "../theme/tokens.generated"
import type { SendReadiness } from "../session-detail"
import { Icon } from "./ui/icon"
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
  onFootprint,
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
  // The thread scrolls underneath the composer, so it has to be told what the
  // composer covers or the newest turn is unreadable.
  onFootprint?: (footprint: number) => void
}) {
  const blocked = !readiness.can
  const canSend = readiness.can && !sending && draft.trim().length > 0

  return (
    // The handoff grows the composer from a pill into a card as soon as it has
    // more than a field to hold. This one always has: what the turn will carry
    // is stated before it is sent, the way the attachment draft states its
    // bytes.
    <FloatingBar shape="card" padding="stack" onFootprint={onFootprint} className="gap-2">
      {problem ? <Text className="text-[11px] text-destructive">{problem}</Text> : null}
      {readiness.can && readiness.hint
        ? <Text variant="note">{readiness.hint}</Text>
        : null}
      {blocked ? <Text variant="note">{readiness.reason}</Text> : null}

      {!blocked ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Skills for this turn: ${skillLabel}`}
          onPress={onOpenSkills}
          className="min-h-tap flex-row items-center gap-1.5 self-start active:opacity-70"
        >
          <Text variant="label">Skills</Text>
          <Text variant="machine" className="text-primary">{skillLabel}</Text>
        </Pressable>
      ) : null}

      <View className="flex-row items-end gap-2.5">
        <TextInput
          multiline
          editable={!blocked && !sending}
          value={draft}
          onChangeText={onChangeDraft}
          placeholder={blocked ? "This session cannot take a message" : "Reply…"}
          placeholderTextColor={colors.dark.faint}
          // Left unset, iOS tints the caret and the selection with its own
          // system blue, which is the one accent on the screen that is not this
          // product's.
          selectionColor={colors.dark.primary}
          accessibilityLabel="Reply to this session"
          className={cn(
            "max-h-32 min-h-tap flex-1 px-1 py-3 font-sans text-[12px] text-foreground",
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
            "min-h-tap min-w-tap items-center justify-center rounded-full",
            canSend ? "bg-primary" : "bg-accent",
          )}
        >
          {sending
            ? <Text className="font-mono text-[15px] text-faint">···</Text>
            : <Icon name="arrow-up" tone={canSend ? "primary-foreground" : "faint"} size={18} />}
        </Pressable>
      </View>
    </FloatingBar>
  )
}
