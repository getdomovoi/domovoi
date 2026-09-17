import { useState } from "react"
import { KeyboardAvoidingView, Modal, Platform, Pressable, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { AgentMarkdown } from "../components/agent-markdown"
import { AttachSheet } from "../components/attach-sheet"
import { Composer } from "../components/composer"
import { PageScroller } from "../components/page-scroller"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, PressableCard } from "../components/ui/card"
import { Icon } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import { cn } from "../lib/cn"
import type { ArtifactRow } from "../artifact-rows"
import { planStrip, type PlanRow, type PlanSummary } from "../plan-rows"
import type { Attachment } from "../attachments"
import type { SessionDetail, ThreadEntry } from "../session-detail"
import { colors } from "../theme/tokens.generated"

// The handoff tints a step's mark with the state it is in rather than outlining
// it, so a plan reads as a column of coloured marks at a glance.
const markTone: Record<PlanRow["tone"], string> = {
  done: "bg-success/20 text-success",
  blocked: "bg-warning/20 text-warning",
  running: "bg-primary/20 text-primary",
  queued: "bg-muted text-faint",
}

const textTone: Record<PlanRow["tone"], string> = {
  done: "text-foreground",
  blocked: "text-foreground",
  running: "text-foreground",
  queued: "text-muted-foreground",
}

function Entry({ entry }: { entry: ThreadEntry }) {
  if (entry.voice === "you") {
    return (
      <View className="max-w-[84%] self-end rounded-[13px] rounded-br-[4px] border border-border bg-accent px-[13px] py-2.5">
        <Text variant="body">{entry.body}</Text>
      </View>
    )
  }
  if (entry.voice === "agent") {
    return (
      <View className="flex-row gap-2.5">
        <View className="h-[22px] w-[22px] items-center justify-center rounded-md border border-border">
          <Text className="font-mono text-machine text-primary">◆</Text>
        </View>
        <AgentMarkdown body={entry.body} className="flex-1" />
      </View>
    )
  }
  return (
    <View className="flex-row items-start gap-2.5 rounded-xl border border-info-border bg-info-bg px-3 py-2.5">
      <View className="mt-1.5 h-1.5 w-1.5 rounded-full bg-info" />
      <View className="flex-1">
        <Text className="text-[11px] leading-[17px] text-info-fg">{entry.body}</Text>
        {entry.meta
          ? <Text variant="machine" className="mt-1 text-faint">{entry.meta}</Text>
          : null}
      </View>
    </View>
  )
}

// One step rewritten in place. The editor holds the step it opened on, so
// what is sent is the step's id and its new text, never a position that the
// plan may have moved since.
function StepEditor({ row, index, saving, onSave, onCancel }: {
  row: PlanRow
  index: number
  saving: boolean
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(row.text)
  const usable = text.trim().length > 0
  return (
    <View className="gap-2 px-3 py-2.5">
      <TextInput
        multiline
        autoFocus
        editable={!saving}
        value={text}
        onChangeText={setText}
        selectionColor={colors.dark.primary}
        accessibilityLabel={`Step ${index + 1}`}
        className="min-h-tap rounded-lg border border-border bg-code px-2.5 py-2 font-sans text-[12px] text-foreground"
      />
      <View className="flex-row justify-end gap-2">
        <Button title="Cancel" onPress={onCancel} disabled={saving} />
        <Button
          title="Save step"
          variant="primary"
          onPress={() => { if (usable) onSave(text.trim()) }}
          disabled={saving || !usable}
        />
      </View>
    </View>
  )
}

function PlanCard({ plan, onEditStep, onPin, headed = true }: {
  plan: PlanSummary
  onEditStep: ((stepId: string, text: string) => Promise<void>) | undefined
  // Present on the card in the thread, absent in the sheet: pinning is how the
  // plan leaves the thread, and the sheet is where it comes back from.
  onPin: (() => void) | undefined
  // The sheet carries its own title and revision line above the card.
  headed?: boolean
}) {
  // Editing is a mode the person enters, so a tap on a step in the ordinary
  // reading of the plan does nothing surprising.
  const [editing, setEditing] = useState(false)
  const [openStep, setOpenStep] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const save = async (stepId: string, text: string) => {
    if (!onEditStep) return
    setSaving(true)
    try {
      await onEditStep(stepId, text)
      setOpenStep(undefined)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Card flush>
      {headed ? (
        <View className="flex-row items-center gap-2 border-b border-border px-3 py-2.5">
          <Text variant="section" className="flex-1">Working plan</Text>
          <Text variant="machine">{plan.progress}</Text>
          {plan.revised ? <Text variant="machine" className="text-faint">{plan.revised}</Text> : null}
        </View>
      ) : null}
      {plan.rows.map((row, index) => {
        const body = (
          <View className="flex-row items-start gap-2.5">
            <View className={cn(
              "mt-px h-[17px] w-[17px] items-center justify-center rounded-full",
              markTone[row.tone],
            )}>
              {/* A finished step carries a tick, and neither loaded face has a
                  glyph for one, so the mark is drawn rather than typed. */}
              {row.tone === "done"
                ? <Icon name="check" tone="success" size={11} />
                : <Text variant="machine" className={cn(markTone[row.tone])}>{row.mark}</Text>}
            </View>
            <View className="flex-1">
              <Text className={cn("text-[12px] leading-[17px]", textTone[row.tone])}>{row.text}</Text>
              <Text variant="machine" className="mt-[3px] text-faint">{row.meta}</Text>
            </View>
            {editing ? <Icon name="pencil" tone="faint" size={13} /> : null}
          </View>
        )
        if (openStep === row.id) {
          return (
            <View key={row.id} className={cn(index > 0 && "border-t border-border")}>
              <StepEditor
                row={row}
                index={index}
                saving={saving}
                onSave={(text) => void save(row.id, text)}
                onCancel={() => setOpenStep(undefined)}
              />
            </View>
          )
        }
        return editing ? (
          <Pressable
            key={row.id}
            accessibilityRole="button"
            accessibilityLabel={`Edit step ${index + 1}: ${row.text}`}
            onPress={() => setOpenStep(row.id)}
            className={cn("px-3 py-2.5 active:opacity-70", index > 0 && "border-t border-border")}
          >
            {body}
          </Pressable>
        ) : (
          <View key={row.id} className={cn("px-3 py-2.5", index > 0 && "border-t border-border")}>
            {body}
          </View>
        )
      })}
      {plan.pendingEdit ? (
        <View className="border-t border-border px-3 py-2.5">
          <Text variant="note">
            {plan.pendingEdit === "queued"
              ? "An edit to these steps is waiting for the agent to pick it up."
              : "An edit to these steps no longer matches the plan and needs redoing."}
          </Text>
        </View>
      ) : null}
      {onEditStep ? (
        <View className="gap-2 border-t border-border px-3 py-2.5">
          {/* The plan is a document, and an edit says when it takes effect. */}
          <Text variant="note">
            Editing a step here applies at the next turn boundary, not to the turn in flight.
          </Text>
          <View className="flex-row gap-2">
            <Button
              title={editing ? "Done editing" : "Edit a step"}
              onPress={() => { setEditing(!editing); setOpenStep(undefined) }}
              disabled={saving}
            />
            {onPin ? <Button title="Pin" accessibilityLabel="Pin the plan" onPress={onPin} disabled={saving} /> : null}
          </View>
        </View>
      ) : null}
      {!onEditStep && onPin ? (
        <View className="flex-row border-t border-border px-3 py-2.5">
          <Button title="Pin" accessibilityLabel="Pin the plan" onPress={onPin} />
        </View>
      ) : null}
    </Card>
  )
}

// The strip that stands in for the plan while it is pinned: one line saying
// where the machine is. Tapping it lifts the whole plan as a sheet, and the
// thread stays behind, so the person has not left the conversation.
function PlanStrip({ plan, onOpen }: { plan: PlanSummary, onOpen: () => void }) {
  const line = planStrip(plan)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={line}
      onPress={onOpen}
      className="flex-row items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-2.5 active:opacity-70"
    >
      <Icon name="list-checks" tone="primary" size={15} />
      <Text className="flex-1 text-[12px] text-strong" numberOfLines={1}>{line}</Text>
      {plan.pendingEdit ? <Text variant="machine" className="text-warning">edit {plan.pendingEdit}</Text> : null}
      <Icon name="chevron-up" tone="faint" size={14} />
    </Pressable>
  )
}

function PlanSheet({ plan, open, onClose, onUnpin, onEditStep }: {
  plan: PlanSummary
  open: boolean
  onClose: () => void
  onUnpin: () => void
  onEditStep: ((stepId: string, text: string) => Promise<void>) | undefined
}) {
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-desk/80" accessibilityLabel="Close the plan" onPress={onClose} />
      <View className="max-h-[80%] gap-3 rounded-t-2xl border-t border-border bg-background p-4 pb-8">
        <View className="items-center">
          <View className="h-1 w-[38px] rounded-full bg-muted" />
        </View>
        <View className="flex-row items-center gap-2.5 px-1">
          <Icon name="pin" tone="warning" size={15} />
          <Text variant="nav" className="flex-1">The plan</Text>
          {plan.revised ? <Text variant="machine" className="text-faint">{plan.revised}</Text> : null}
        </View>
        <PageScroller contentContainerClassName="gap-3">
          <PlanCard plan={plan} onEditStep={onEditStep} onPin={undefined} headed={false} />
          <Text variant="note" className="px-1">
            Pinned stays pinned across screens. Unpin and it collapses back into the thread.
          </Text>
          <View className="flex-row gap-2">
            <Button title="Unpin" onPress={onUnpin} className="flex-1" />
          </View>
        </PageScroller>
      </View>
    </Modal>
  )
}

function ArtifactList({
  rows,
  onOpen,
}: {
  rows: ArtifactRow[]
  onOpen: (artifactId: string) => void
}) {
  return (
    <Card flush>
      <View className="border-b border-border px-3 py-2.5">
        <Text variant="section">Artifacts</Text>
      </View>
      {rows.map((row, index) => (
        <Pressable
          key={row.id}
          accessibilityRole="button"
          accessibilityLabel={`Open ${row.title}`}
          onPress={() => onOpen(row.id)}
          className={cn(
            "min-h-tap flex-row items-center gap-2.5 px-3 py-2.5 active:opacity-70",
            index > 0 && "border-t border-border",
          )}
        >
          <View className="flex-1">
            <View className="flex-row items-center gap-1.5">
              <Text className="text-[12px]" numberOfLines={1}>{row.title}</Text>
              {row.variantLabel ? <Badge label={row.variantLabel} tone="outline" /> : null}
            </View>
            {/* An artifact the phone cannot read says so here rather than
                opening onto an empty frame. */}
            <Text
              variant="machine"
              className={cn("mt-[3px]", row.readable ? "text-faint" : "text-warn-dim")}
            >
              {row.detail}
            </Text>
          </View>
          <Icon name="chevron-right" tone="faint" size={16} />
        </Pressable>
      ))}
    </Card>
  )
}


export function SessionScreen({
  detail,
  artifacts,
  plan,
  pausing,
  draft,
  sending,
  sendProblem,
  skillLabel,
  onBack,
  onOpenApproval,
  onOpenArtifact,
  onPause,
  onChangeDraft,
  onSend,
  onOpenSkills,
  onEditStep,
  planPinned,
  onPinPlan,
  machine,
  attachments,
  attachmentSummary,
  attachmentsAllowed,
  attachProblem,
  onPickLibrary,
  onTakePhoto,
  onRemoveAttachment,
}: {
  detail: SessionDetail
  artifacts: ArtifactRow[]
  plan: PlanSummary | undefined
  pausing: boolean
  draft: string
  sending: boolean
  sendProblem: string
  skillLabel: string
  onBack: () => void
  onOpenApproval: (approvalId: string) => void
  onOpenArtifact: (artifactId: string) => void
  onPause: () => void
  onChangeDraft: (draft: string) => void
  onSend: () => void
  onOpenSkills: () => void
  // Absent when the phone has no way to send an edit, in which case the plan
  // is read-only and says nothing about editing.
  onEditStep?: ((stepId: string, text: string) => Promise<void>) | undefined
  // Held by the app rather than this screen, so the pin survives leaving and
  // coming back. Pinned stays pinned across screens.
  planPinned: boolean
  onPinPlan: (pinned: boolean) => void
  // Frames 13 and 14. The queue and its size line live in the composer; the
  // sheet names the sources. All of it is app state, because the bytes are
  // sent with the turn from there.
  machine: string
  attachments: readonly Attachment[]
  attachmentSummary: string | undefined
  attachmentsAllowed: boolean
  attachProblem: string
  onPickLibrary: () => void
  onTakePhoto: () => void
  onRemoveAttachment: (index: number) => void
}) {
  const [attachOpen, setAttachOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  // The composer floats over the thread, so the thread pads by what the
  // composer reports covering rather than by a guess at its height.
  const [composerFootprint, setComposerFootprint] = useState(0)
  const approvalId = detail.approvalId
  // The screen sits inside the safe area, so the keyboard's height is measured
  // from a frame that starts below the status bar. Without the offset the
  // composer is lifted short by exactly that much and the keyboard covers its
  // bottom rows.
  const insets = useSafeAreaInsets()
  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={insets.top}
    >
      <View className="flex-row items-center gap-2.5 px-3.5 pb-3 pt-1.5">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to sessions"
          onPress={onBack}
          className="min-h-tap min-w-tap -ml-3 items-center justify-center active:opacity-70"
        >
          <Icon name="chevron-left" tone="primary" />
        </Pressable>
        <View className="flex-1">
          <Text variant="nav" numberOfLines={1}>{detail.title}</Text>
          <Text variant="machine">{detail.runtime}</Text>
        </View>
        <Badge label={detail.mode} tone="outline" />
      </View>

      <PageScroller
        contentContainerClassName="gap-3 px-3.5"
        bottomInset={composerFootprint}
        followEnd
        testID="thread"
      >
        {/* The reason the phone was picked up goes above the reading, because
            scrolling a thread to find the decision is the slow path. */}
        {approvalId ? (
          <PressableCard
            className="border-warn-border bg-warn-bg"
            accessibilityLabel="Open the waiting approval"
            onPress={() => onOpenApproval(approvalId)}
          >
            <View className="flex-row items-center gap-2">
              <Text className="flex-1 font-sans-medium text-[12.5px] text-warn-fg">
                An approval is waiting
              </Text>
              <Icon name="chevron-right" tone="warn-fg" size={16} />
            </View>
          </PressableCard>
        ) : null}

        {plan && planPinned ? <PlanStrip plan={plan} onOpen={() => setPlanOpen(true)} /> : null}
        {plan && !planPinned ? <PlanCard plan={plan} onEditStep={onEditStep} onPin={() => onPinPlan(true)} /> : null}

        {artifacts.length > 0 ? <ArtifactList rows={artifacts} onOpen={onOpenArtifact} /> : null}

        {detail.omitted > 0 ? (
          <Text variant="note" className="text-center">
            {detail.omitted} earlier item{detail.omitted === 1 ? "" : "s"} are not on this phone.
          </Text>
        ) : null}

        {detail.entries.length === 0
          ? <Text variant="meta">Nothing has been said in this session yet.</Text>
          : null}
        {detail.entries.map((entry) => <Entry key={entry.id} entry={entry} />)}

        <Card className="gap-2">
          <Text variant="label">Session control</Text>
          <Text variant="note">
            {detail.pausable
              ? "Stops the turn this session is running. Work already done is kept."
              : `Nothing is running to pause. This session is ${detail.state}.`}
          </Text>
          <Button
            title="Pause this session"
            shape="block"
            disabled={!detail.pausable || pausing}
            onPress={onPause}
          />
        </Card>
      </PageScroller>

      {plan && planPinned ? (
        <PlanSheet
          plan={plan}
          open={planOpen}
          onClose={() => setPlanOpen(false)}
          onUnpin={() => { setPlanOpen(false); onPinPlan(false) }}
          onEditStep={onEditStep}
        />
      ) : null}

      <Composer
        draft={draft}
        readiness={detail.sending}
        sending={sending}
        problem={sendProblem}
        skillLabel={skillLabel}
        onChangeDraft={onChangeDraft}
        onSend={onSend}
        onOpenSkills={onOpenSkills}
        attachments={attachments}
        attachmentSummary={attachmentSummary}
        attachmentsAllowed={attachmentsAllowed}
        onOpenAttach={() => setAttachOpen(true)}
        onRemoveAttachment={onRemoveAttachment}
        onFootprint={setComposerFootprint}
      />
      <AttachSheet
        open={attachOpen}
        machine={machine}
        problem={attachProblem}
        onPickLibrary={() => { setAttachOpen(false); onPickLibrary() }}
        onTakePhoto={() => { setAttachOpen(false); onTakePhoto() }}
        onClose={() => setAttachOpen(false)}
      />
    </KeyboardAvoidingView>
  )
}
