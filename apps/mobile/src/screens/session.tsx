import { memo, useCallback, useEffect, useRef, useState } from "react"
import { KeyboardAvoidingView, Modal, Platform, Pressable, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { threadFollowState, type ClientAccess, type PermissionMode, type QueuedSessionSend } from "@getdomovoi/protocol"

import type { ConnectionNotice } from "../connection-notice"

import { AgentMarkdown } from "../components/agent-markdown"
import { AttachSheet } from "../components/attach-sheet"
import { BlurBackdrop } from "../components/blur-backdrop"
import { StartLikeSheet } from "../components/start-like-sheet"
import { Composer } from "../components/composer"
import { ConnectionBanner } from "../components/connection-banner"
import { JumpPill } from "../components/jump-pill"
import { PageScroller, type PageScrollerHandle } from "../components/page-scroller"
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
import { useTheme } from "../theme/theme-provider"

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

// Memoized, with a stable onWatch from the screen: a keystroke or a streamed
// batch re-renders the screen, and a row that has not changed is not drawn or
// parsed again.
function Receipt({ entry, onWatch }: {
  entry: Extract<ThreadEntry, { kind: "receipt" }>
  onWatch: () => void
}) {
  // A deny is not a success, so it does not wear the success colours.
  const denied = entry.recorded === "deny" || entry.recorded === "deny-explain"
  const dim = denied ? "text-muted-foreground" : "text-ok-dim"
  const record: Array<[string, string]> = [
    ["Decision", entry.recorded],
    ["Decided on", entry.client],
    ...(entry.declaredClient ? [["Declared client", entry.declaredClient] as [string, string]] : []),
    ["Checkpoint", entry.checkpoint],
  ]
  return (
    <View className="gap-3">
      <View className={cn("gap-[7px] rounded-2xl border px-4 py-[15px]", denied ? "border-border bg-card" : "border-ok-border bg-ok-bg")}>
        <View className="flex-row items-center gap-2.5">
          <View className={cn("h-[9px] w-[9px] rounded-full", denied ? "bg-faint" : "bg-success")} />
          <Text className={cn("font-sans-semibold text-[19px] leading-[24px] tracking-[-0.015em]", denied ? "text-strong" : "text-ok-fg")}>{entry.decision}</Text>
        </View>
        {/* The checkpoint comes before the run, so the line names it first.
            It is named by the commit the daemon recorded, which is the only
            name the receipt carries for it. */}
        {entry.checkpointTaken ? (
          <Text className={cn("font-sans text-[13px] leading-[20px]", dim)}>
            Checkpoint <Text className="font-mono text-[12px]">{entry.checkpoint}</Text>{" "}
            {entry.ranFor
              ? <>was taken first, then it ran in <Text className="font-mono text-[12px]">{entry.ranFor}</Text>.</>
              : "was taken first."}
          </Text>
        ) : null}
        <Text className={cn("font-sans text-[13px] leading-[20px]", dim)}>{entry.operation}</Text>
        {entry.explanation ? <Text className={cn("font-sans text-[13px] leading-[20px]", dim)}>{entry.explanation}</Text> : null}
      </View>
      {/* Ruling Q357 A: the record, the notes and Watch belong to the latest
          receipt of the open turn. A receipt that is history stops above. */}
      {entry.current ? <>
      <View className="overflow-hidden rounded-2xl border border-border">
        <Text variant="label" className="border-b border-border px-[15px] py-[11px] tracking-[0.13em]">RECORDED AS</Text>
        {record.map(([key, value], index) => (
          <View
            key={key}
            accessible
            accessibilityLabel={`${key}, ${value}`}
            className={cn("flex-row items-baseline gap-3 bg-card px-[15px] py-[11px]", index > 0 && "border-t border-border")}
          >
            <Text className="font-sans text-[12.5px] text-muted-foreground">{key}</Text>
            <Text className="flex-1 text-right font-mono text-[12px] text-strong">{value}</Text>
          </View>
        ))}
      </View>
      {/* The note speaks of a phone's verified credential. It is shown only
          for a phone decision whose receipt records its connection; a legacy
          receipt holds a declared id instead. The connection id alone does
          not say which credential opened it, so the note's wording is still
          under review. */}
      {entry.client === "phone" && entry.connectionRecorded ? (
        <Text className="font-sans text-[12px] leading-[19px] text-faint">
          The audit row names this phone's verified credential, not the label you gave it. Renaming the device later does not rewrite the record.
        </Text>
      ) : null}
      <Button title="Watch the rest of the turn" shape="block" onPress={onWatch} />
      <Text className="font-sans text-[12px] leading-[19px] text-faint">Reverting happens on a desktop. A phone answers what a machine proposed; it does not rewind the work.</Text>
      </> : null}
    </View>
  )
}

const Entry = memo(function Entry({ entry, onWatch }: { entry: ThreadEntry, onWatch: () => void }) {
  if (entry.kind === "receipt") return <Receipt entry={entry} onWatch={onWatch} />

  if (entry.kind === "policy-refusal") return null
  // Phone v2 frame 11: yours is filled with the primary colour and tails to
  // the right, the agent's is a bordered card that tails to the left.
  if (entry.kind === "message" && entry.voice === "you") {
    return (
      <View className="max-w-[86%] self-end rounded-[18px] rounded-br-[4px] bg-primary px-3.5 py-[11px]">
        <Text className="font-sans text-[13.5px] leading-[21px] text-primary-foreground">{entry.body}</Text>
      </View>
    )
  }
  if (entry.kind === "message") {
    return (
      <View className="max-w-[86%] self-start rounded-[18px] rounded-bl-[4px] border border-border bg-card px-3.5 py-[11px]">
        <AgentMarkdown body={entry.body} />
      </View>
    )
  }
  return (
    <View className="flex-row items-start gap-2.5 rounded-xl border border-info-border bg-info-bg px-3 py-2.5">
      <View className="mt-1.5 h-1.5 w-1.5 rounded-full bg-info" />
      <View className="flex-1">
        <Text className="text-[11px] leading-[17px] text-info-fg">{entry.body}</Text>
        {entry.meta ? <Text variant="machine" className="mt-1 text-faint">{entry.meta}</Text> : null}
      </View>
    </View>
  )
})

// Ruling Q356 A: the refusal's one remedy can go to the agent as a steer from
// here, because the composer is not drawn under a refusal. The protocol
// carries a single remedy string; frame 05's tone-coded alternatives wait on
// a protocol change.
//
// During a running turn the phone sends as the next turn's message, and the
// daemon lets one such message wait per session: a new one replaces it. So the
// refusal says that before the tap when one is waiting, draws the waiting one
// with its cancel (the thread that would show it is not drawn here), and says
// where the remedy went after the tap.
const replaceable: ReadonlySet<QueuedSessionSend["state"]> = new Set(["waiting", "held", "unconfirmed"])

// How a remedy went: as the next turn's message (next-turn-replace), or
// straight to the session.
export type TellDelivery = "next-turn" | "direct"

function PolicyRefusal({ refusal, onTellAgent, sending, problem, activeTurn, queuedSend, canCancel, onCancelQueuedSend }: {
  refusal: Extract<ThreadEntry, { kind: "policy-refusal" }>
  onTellAgent: ((text: string) => Promise<TellDelivery | undefined>) | undefined
  sending: boolean
  problem: string
  activeTurn: boolean
  queuedSend: QueuedSessionSend | undefined
  canCancel: boolean
  onCancelQueuedSend: (queueId: string) => void
}) {
  // How the remedy was sent at the tap. The turn can end or start before the
  // screen redraws, so the line is picked from this, not from activeTurn.
  const [sent, setSent] = useState<TellDelivery | undefined>(undefined)
  const replaces = activeTurn && queuedSend !== undefined && replaceable.has(queuedSend.state)
  return (
    <View className="gap-3">
      <Text variant="title" className="text-[24px] leading-[30px]">Nothing to approve</Text>
      <PolicyRefusalCards refusal={refusal} />
      {onTellAgent ? (
        <View className="gap-2">
          {replaces && !sent ? (
            <Text variant="note" className="px-1">This replaces the message already queued for the next turn.</Text>
          ) : null}
          <Button
            title="Tell the agent"
            shape="block"
            disabled={sending}
            onPress={() => {
              setSent(undefined)
              void onTellAgent(refusal.remedy).then(setSent)
            }}
          />
          {sent ? (
            <Text accessibilityRole="alert" variant="note" className="px-1">
              {sent === "next-turn" ? "Sent. It will reach the agent when this turn ends." : "Sent to the agent."}
            </Text>
          ) : null}
          {problem ? <Text accessibilityRole="alert" variant="note" className="px-1 text-destructive">{problem}</Text> : null}
        </View>
      ) : null}
      {queuedSend ? (
        <QueuedSendCard queued={queuedSend} canCancel={canCancel} onCancel={onCancelQueuedSend} />
      ) : null}
    </View>
  )
}

export function PolicyRefusalCards({ refusal }: {
  refusal: Extract<ThreadEntry, { kind: "policy-refusal" }>
}) {
  return (
    <>
      <Card className="gap-2 border-danger-border bg-danger-bg">
        <View className="flex-row items-center gap-2.5">
          <View className="h-[9px] w-[9px] rounded-full bg-destructive" />
          <Text className="font-sans-semibold text-[19px] leading-[24px] tracking-[-0.015em] text-danger-fg">Refused by policy</Text>
        </View>
        <Text variant="meta" className="text-danger-fg">There is no approve button here, because no decision of yours can permit it. The daemon refused before the command ran.</Text>
        <View className="rounded-xl bg-code p-3">
          <Text variant="machine" className="text-danger-fg">{refusal.command}</Text>
        </View>
      </Card>
      <Card className="gap-2 border-danger-border">
        <Text variant="label" className="text-danger-dim">THE RULE IT BROKE</Text>
        <Text variant="title" className="text-danger-fg">{refusal.rule}</Text>
        <Text variant="meta" className="text-danger-dim">{refusal.setBy}</Text>
        <Text variant="meta" className="text-danger-dim">{refusal.scope}</Text>
      </Card>
      <Card className="gap-2">
        <Text variant="label">WHAT YOU CAN DO</Text>
        <Text variant="meta">{refusal.remedy}</Text>
      </Card>
    </>
  )
}

export function keyboardAvoidance(platform: string, top: number) {
  return {
    behavior: platform === "ios" ? "padding" as const : undefined,
    keyboardVerticalOffset: top,
  }
}

const queueLabels: Record<QueuedSessionSend["state"], string> = {
  waiting: "Waiting for the next turn",
  held: "Held for the next turn",
  refused: "Refused by the daemon",
  unconfirmed: "Delivery unconfirmed",
  delivered: "Delivered to the next turn",
}

function QueuedSendCard({ queued, canCancel, onCancel }: {
  queued: QueuedSessionSend
  canCancel: boolean
  onCancel: (queueId: string) => void
}) {
  const cancellable = queued.state === "waiting" || queued.state === "held" || queued.state === "unconfirmed"
  return (
    <Card className="gap-2 border-info-border bg-info-bg">
      <Text variant="section" className="text-info-fg">{queueLabels[queued.state]}</Text>
      {queued.reason ? <Text variant="note" className="text-info-dim">{queued.reason}</Text> : null}
      {cancellable && canCancel ? <Button title="Cancel queued message" onPress={() => onCancel(queued.id)} /> : null}
    </Card>
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
  const { palette } = useTheme()
  const usable = text.trim().length > 0
  return (
    <View className="gap-2 px-3 py-2.5">
      <TextInput
        multiline
        autoFocus
        editable={!saving}
        value={text}
        onChangeText={setText}
        selectionColor={palette.primary}
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
            <Button title="Looks right" variant="primary" onPress={onClose} className="flex-1" />
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
  notice,
  artifacts,
  plan,
  pausing,
  draft,
  sending,
  sendProblem,
  skillLabel,
  access,
  onBack,
  onWatchReceipt,
  onCancelQueuedSend,
  onComposerFocusChange,
  composerBottomInset,
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
  starting,
  startProblem,
  onStartLike,
  onTellAgent,
}: {
  detail: SessionDetail
  // The route can die while the thread is open; the screen says what is drawn
  // is the last state the phone was sent.
  notice?: ConnectionNotice | undefined
  artifacts: ArtifactRow[]
  plan: PlanSummary | undefined
  pausing: boolean
  draft: string
  sending: boolean
  sendProblem: string
  skillLabel: string
  access: ClientAccess
  onBack: () => void
  onWatchReceipt: () => void
  onCancelQueuedSend: (queueId: string) => void
  onComposerFocusChange: (focused: boolean) => void
  composerBottomInset?: number | undefined
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
  // Start another session like this one: same machine, repository, provider
  // and model, with words from the person and a mode, Plan by default.
  starting: boolean
  startProblem: string
  onStartLike: (prompt: string, mode: PermissionMode) => void
  // Sends a policy refusal's remedy to the agent as a steer (ruling Q356 A).
  // Resolves to how the daemon took the message, or undefined when it did not.
  onTellAgent?: ((text: string) => Promise<TellDelivery | undefined>) | undefined
}) {
  const [startOpen, setStartOpen] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  // The composer floats over the thread, so the thread pads by what the
  // composer reports covering rather than by a guess at its height.
  const [composerFootprint, setComposerFootprint] = useState(0)
  const approvalId = detail.approvalId

  // The thread follows only at the bottom. Scrolled up, what lands is counted
  // for the pill and the viewport is left alone; a gate waiting below names
  // itself instead of a count. Back at the bottom, by hand or by the pill,
  // the count clears.
  const thread = useRef<PageScrollerHandle>(null)
  const watchReceipt = useCallback(() => {
    onWatchReceipt()
    thread.current?.scrollToEnd()
  }, [onWatchReceipt])
  const [atEnd, setAtEnd] = useState(true)
  const [unseen, setUnseen] = useState(0)
  const seenEntries = useRef(detail.entries.length)
  const seenSession = useRef(detail.id)
  useEffect(() => {
    if (seenSession.current !== detail.id) {
      seenSession.current = detail.id
      seenEntries.current = detail.entries.length
      setUnseen(0)
      return
    }
    const delta = detail.entries.length - seenEntries.current
    seenEntries.current = detail.entries.length
    if (delta > 0 && !atEnd) setUnseen((count) => count + delta)
  }, [atEnd, detail.entries.length, detail.id])
  const follow = threadFollowState({ atBottom: atEnd, unseen, gated: Boolean(approvalId) })
  // The screen sits inside the safe area, so the keyboard's height is measured
  // from a frame that starts below the status bar. Without the offset the
  // composer is lifted short by exactly that much and the keyboard covers its
  // bottom rows.
  const insets = useSafeAreaInsets()
  const keyboard = keyboardAvoidance(Platform.OS, insets.top)
  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={keyboard.behavior}
      keyboardVerticalOffset={keyboard.keyboardVerticalOffset}
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
        {access === "watching" ? <Badge label="watching" tone="outline" /> : <Badge label={detail.mode} tone="outline" />}
      </View>

      {/* What the composer and the tab bar blur on Android. Both stay outside
          it: the composer below, the tab bar beside this screen in app.tsx. */}
      <BlurBackdrop style={{ flex: 1 }}>
        <PageScroller
          ref={thread}
          contentContainerClassName="gap-3 px-3.5"
          bottomInset={composerFootprint}
          followEnd
          onAtEndChange={(next) => { setAtEnd(next); if (next) setUnseen(0) }}
          testID="thread"
        >
          <ConnectionBanner notice={notice} />
          {detail.policyRefusal ? (
            <PolicyRefusal
              // A new refusal starts with nothing sent.
              key={detail.policyRefusal.id}
              refusal={detail.policyRefusal}
              onTellAgent={access === "full" && detail.sending.can ? onTellAgent : undefined}
              sending={sending}
              problem={sendProblem}
              activeTurn={detail.activeTurn}
              queuedSend={detail.queuedSend}
              canCancel={access === "full"}
              onCancelQueuedSend={onCancelQueuedSend}
            />
          ) : <>
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
                  {access === "full" ? "An approval is waiting" : "An approval is waiting on a full-access device"}
                </Text>
                <Icon name="chevron-right" tone="warn-fg" size={16} />
              </View>
            </PressableCard>
          ) : null}

          {plan && planPinned ? <PlanStrip plan={plan} onOpen={() => setPlanOpen(true)} /> : null}
          {plan && !planPinned ? <PlanCard plan={plan} onEditStep={access === "full" ? onEditStep : undefined} onPin={() => onPinPlan(true)} /> : null}

          {artifacts.length > 0 ? <ArtifactList rows={artifacts} onOpen={onOpenArtifact} /> : null}

          {detail.omitted > 0 ? (
            <Text variant="note" className="text-center">
              {detail.omitted} earlier item{detail.omitted === 1 ? "" : "s"} are not on this phone.
            </Text>
          ) : null}

          {/* A fresh session is a readiness, not an absence: the worktree is
              cut and the agent has not been given a turn. The first message is
              what starts it, so the line says that rather than "nothing". */}
          {detail.entries.length === 0
            ? (
              <View className="gap-1">
                <Text className="font-sans-medium text-[13px] text-foreground">Nothing has run yet</Text>
                <Text variant="meta">
                  {detail.sending.can
                    ? "The session exists, the worktree is cut, and the agent has not been given a turn. Your first message is what starts it."
                    : "The session exists and the agent has not been given a turn."}
                </Text>
              </View>
            )
            : null}
          {detail.queuedSend ? (
            <QueuedSendCard
              queued={detail.queuedSend}
              canCancel={access === "full"}
              onCancel={onCancelQueuedSend}
            />
          ) : null}
          {detail.entries.map((entry) => (
            <Entry key={entry.id} entry={entry} onWatch={watchReceipt} />
          ))}

          {access === "full" ? <Card className="gap-2">
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
            <Text variant="note">
              Or start another session on the same machine and repository, with this one's
              provider and model.
            </Text>
            <Button title="Start another like this one" shape="block" onPress={() => setStartOpen(true)} />
          </Card> : null}
          </>}
        </PageScroller>
      </BlurBackdrop>

      <StartLikeSheet
        open={startOpen}
        like={{ title: detail.title, machine, runtime: detail.runtime }}
        starting={starting}
        problem={startProblem}
        onStart={(prompt, mode) => onStartLike(prompt, mode)}
        onClose={() => setStartOpen(false)}
      />

      {plan && planPinned ? (
        <PlanSheet
          plan={plan}
          open={planOpen}
          onClose={() => setPlanOpen(false)}
          onUnpin={() => { setPlanOpen(false); onPinPlan(false) }}
          onEditStep={access === "full" ? onEditStep : undefined}
        />
      ) : null}

      <JumpPill state={follow} unseen={unseen} above={composerFootprint} watching={access !== "full"} onPress={() => thread.current?.scrollToEnd()} />
      {!detail.policyRefusal ? <Composer
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
        planAvailable={plan !== undefined}
        onOpenPlan={() => {
          if (plan && !planPinned) onPinPlan(true)
          if (plan) setPlanOpen(true)
        }}
        onFocusChange={onComposerFocusChange}
        bottomInset={composerBottomInset}
        onOpenAttach={() => setAttachOpen(true)}
        onRemoveAttachment={onRemoveAttachment}
        onFootprint={setComposerFootprint}
      /> : null}
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
