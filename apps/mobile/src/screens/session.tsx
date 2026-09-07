import { useState } from "react"
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native"

import { Composer } from "../components/composer"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, PressableCard } from "../components/ui/card"
import { Icon } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import { cn } from "../lib/cn"
import type { ArtifactRow } from "../artifact-rows"
import type { PlanRow, PlanSummary } from "../plan-rows"
import type { SessionDetail, ThreadEntry } from "../session-detail"

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
          <Text className="font-mono text-[9.5px] text-primary">◆</Text>
        </View>
        <Text variant="body" className="flex-1 leading-[20px]">{entry.body}</Text>
      </View>
    )
  }
  return (
    <View className="flex-row items-start gap-2.5 rounded-xl border border-info-border bg-info-bg px-3 py-2.5">
      <View className="mt-1.5 h-1.5 w-1.5 rounded-full bg-info" />
      <View className="flex-1">
        <Text className="text-[11px] leading-[17px] text-info-fg">{entry.body}</Text>
        {entry.meta
          ? <Text variant="machine" className="mt-1 text-[9px] text-faint">{entry.meta}</Text>
          : null}
      </View>
    </View>
  )
}

function PlanCard({ plan }: { plan: PlanSummary }) {
  return (
    <Card flush>
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-2.5">
        <Text variant="section">Working plan</Text>
        <Text variant="machine">{plan.progress}</Text>
      </View>
      {plan.rows.map((row, index) => (
        <View
          key={row.id}
          className={cn(
            "flex-row items-start gap-2.5 px-3 py-2.5",
            index > 0 && "border-t border-border",
          )}
        >
          <View className={cn(
            "mt-px h-[17px] w-[17px] items-center justify-center rounded-full",
            markTone[row.tone],
          )}>
            {/* A finished step carries a tick, and neither loaded face has a
                glyph for one, so the mark is drawn rather than typed. */}
            {row.tone === "done"
              ? <Icon name="check" tone="success" size={11} />
              : <Text className={cn("font-mono text-[9px]", markTone[row.tone])}>{row.mark}</Text>}
          </View>
          <View className="flex-1">
            <Text className={cn("text-[12px] leading-[17px]", textTone[row.tone])}>{row.text}</Text>
            <Text variant="machine" className="mt-[3px] text-[9px] text-faint">{row.meta}</Text>
          </View>
        </View>
      ))}
      {plan.pendingEdit ? (
        <View className="border-t border-border px-3 py-2.5">
          <Text variant="note">
            {plan.pendingEdit === "queued"
              ? "An edit to these steps is waiting for the agent to pick it up."
              : "An edit to these steps no longer matches the plan and needs redoing."}
          </Text>
        </View>
      ) : null}
    </Card>
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
              className={cn("mt-[3px] text-[9px]", row.readable ? "text-faint" : "text-warn-dim")}
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
}) {
  // The composer floats over the thread, so the thread pads by what the
  // composer reports covering rather than by a guess at its height.
  const [composerFootprint, setComposerFootprint] = useState(0)
  const approvalId = detail.approvalId
  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
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

      <ScrollView
        contentContainerClassName="gap-3 px-3.5"
        contentContainerStyle={{ paddingBottom: composerFootprint }}
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

        {plan ? <PlanCard plan={plan} /> : null}

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
      </ScrollView>

      <Composer
        draft={draft}
        readiness={detail.sending}
        sending={sending}
        problem={sendProblem}
        skillLabel={skillLabel}
        onChangeDraft={onChangeDraft}
        onSend={onSend}
        onOpenSkills={onOpenSkills}
        onFootprint={setComposerFootprint}
      />
    </KeyboardAvoidingView>
  )
}
