import { useState } from "react"
import { Pressable, TextInput, View } from "react-native"

import type { Attachment, ModelImages } from "../attachments"
import { cn } from "../lib/cn"
import type { SendReadiness } from "../session-detail"
import { useTheme } from "../theme/theme-provider"
import { FloatingBar } from "./floating-bar"
import { Icon } from "./ui/icon"
import { Text } from "./ui/text"

export function Composer({
  draft,
  readiness,
  sending,
  problem,
  skillLabel,
  attachments,
  attachmentSummary,
  attachmentsAllowed,
  planAvailable,
  onChangeDraft,
  onSend,
  onOpenSkills,
  onOpenPlan,
  onOpenAttach,
  onRemoveAttachment,
  onRemoveAttachments,
  images,
  onFocusChange,
  bottomInset,
  onFootprint,
}: {
  draft: string
  readiness: SendReadiness
  sending: boolean
  problem: string
  skillLabel: string
  attachments: readonly Attachment[]
  attachmentSummary: string | undefined
  attachmentsAllowed: boolean
  planAvailable: boolean
  onChangeDraft: (draft: string) => void
  onSend: () => void
  onOpenSkills: () => void
  onOpenPlan: () => void
  onOpenAttach: () => void
  onRemoveAttachment: (index: number) => void
  // Frame 14b's Remove N images: drops every queued image at once.
  onRemoveAttachments: () => void
  // The session's model and what its harness reports about image input.
  images?: ModelImages | undefined
  onFocusChange: (focused: boolean) => void
  bottomInset?: number | undefined
  onFootprint?: ((footprint: number) => void) | undefined
}) {
  const [focused, setFocused] = useState(false)
  const { palette } = useTheme()
  const blocked = !readiness.can
  const expanded = focused || attachments.length > 0 || Boolean(problem) || blocked
  const wordless = attachments.length > 0 && draft.trim().length === 0
  // Frame 14b: queued images a model reported to take none lock send before
  // it is pressed. Not knowing does not lock it; the line says so instead.
  const imagesBlocked = attachments.length > 0 && images?.imageInput === false
  const imagesUnknown = attachments.length > 0 && images !== undefined && images.imageInput === undefined
  const imageCount = attachments.length === 1 ? "1 image" : `${attachments.length} images`
  const canSend = readiness.can && !sending && draft.trim().length > 0 && !imagesBlocked
  const focus = (next: boolean) => {
    setFocused(next)
    onFocusChange(next)
  }

  return (
    <FloatingBar
      shape={expanded ? "card" : "pill"}
      padding={expanded ? "stack" : "composer"}
      bottomInset={bottomInset}
      onFootprint={onFootprint}
      className={expanded ? "gap-2" : ""}
    >
      {problem ? <Text className="text-[11px] text-destructive">{problem}</Text> : null}
      {readiness.can && readiness.hint ? <Text variant="note">{readiness.hint}</Text> : null}
      {blocked ? <Text variant="note">{readiness.reason}</Text> : null}

      {expanded && !blocked ? (
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

      {attachments.length > 0 ? (
        <View className="gap-1.5">
          {attachments.map((attachment, index) => (
            <View key={`${index}-${attachment.name}`} className="flex-row items-center gap-2 rounded-lg border border-border bg-code px-2.5 py-1.5">
              <Icon name="image" tone="primary" size={14} />
              <Text variant="machine" className="flex-1 text-strong" numberOfLines={1}>{attachment.name}</Text>
              <Text variant="machine" className="text-faint">{`${(attachment.bytes / 1_000_000).toFixed(1)} MB`}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${attachment.name}`}
                onPress={() => onRemoveAttachment(index)}
                disabled={sending}
                className="min-h-[28px] min-w-[28px] items-center justify-center active:opacity-70"
              >
                <Icon name="x" tone="faint" size={14} />
              </Pressable>
            </View>
          ))}
          {attachmentSummary ? <Text variant="note">{attachmentSummary}</Text> : null}
          {wordless ? <Text variant="note" className="text-warning">Say what the image is for; a turn needs words.</Text> : null}
          {imagesBlocked && images ? (
            <View className="gap-2 rounded-lg border border-warn-border bg-warn-bg px-2.5 py-2">
              <Text className="text-[11.5px] leading-[17px] text-warn-fg">
                {`${imageCount} cannot go to `}
                <Text className="font-mono text-[11px]">{images.model}</Text>
                {attachments.length === 1 ? ". Remove it or pick another model." : ". Remove them or pick another model."}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${imageCount}`}
                onPress={onRemoveAttachments}
                disabled={sending}
                className="min-h-[36px] items-center justify-center self-start rounded-full border border-warn-border px-3.5 active:opacity-70"
              >
                <Text className="font-sans-medium text-[12px] text-warn-fg">{`Remove ${imageCount}`}</Text>
              </Pressable>
            </View>
          ) : null}
          {imagesUnknown && images ? (
            <Text variant="note">{`Domovoi does not know whether ${images.model} takes image input. If it does not, the machine refuses the send and nothing is sent.`}</Text>
          ) : null}
        </View>
      ) : null}

      <View className="flex-row items-end gap-2">
        <TextInput
          multiline
          editable={!blocked && !sending}
          value={draft}
          onChangeText={onChangeDraft}
          onFocus={() => focus(true)}
          onBlur={() => focus(false)}
          placeholder={blocked ? "This session cannot take a message" : "Steer it, or queue a message"}
          placeholderTextColor={palette.faint}
          selectionColor={palette.primary}
          accessibilityLabel="Reply to this session"
          className={cn(
            "max-h-32 min-h-tap flex-1 px-1 py-3 font-sans text-[12px] text-foreground",
            blocked && "opacity-50",
          )}
        />
        {!blocked && planAvailable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open plan"
            onPress={onOpenPlan}
            disabled={sending}
            className="min-h-tap min-w-tap items-center justify-center rounded-full active:opacity-70"
          >
            <Icon name="list-checks" tone="primary" size={18} />
          </Pressable>
        ) : null}
        {!blocked && attachmentsAllowed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach an image"
            onPress={onOpenAttach}
            disabled={sending}
            className="min-h-tap min-w-tap items-center justify-center rounded-full active:opacity-70"
          >
            <Icon name="plus" tone="muted" size={18} />
          </Pressable>
        ) : null}
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
