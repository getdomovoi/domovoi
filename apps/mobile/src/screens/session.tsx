import { ScrollView, View } from "react-native"

import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, PressableCard } from "../components/ui/card"
import { Text } from "../components/ui/text"
import { cn } from "../lib/cn"
import type { PlanRow, PlanSummary } from "../plan-rows"
import type { SessionDetail, ThreadEntry } from "../session-detail"

const markTone: Record<PlanRow["tone"], string> = {
  done: "border-success text-success",
  blocked: "border-warn-border bg-warn-bg text-warn-fg",
  running: "border-primary text-primary",
  queued: "border-border text-faint",
}

const textTone: Record<PlanRow["tone"], string> = {
  done: "text-strong",
  blocked: "text-foreground",
  running: "text-foreground",
  queued: "text-muted-foreground",
}

function Entry({ entry }: { entry: ThreadEntry }) {
  if (entry.voice === "you") {
    return (
      <View className="max-w-[84%] self-end rounded-lg rounded-br border border-border bg-accent px-3.5 py-2.5">
        <Text className="text-[12.5px] leading-5">{entry.body}</Text>
      </View>
    )
  }
  if (entry.voice === "agent") {
    return (
      <View className="flex-row gap-2.5">
        <View className="h-[22px] w-[22px] items-center justify-center rounded border border-border">
          <Text className="text-[9.5px] text-primary">◆</Text>
        </View>
        <Text className="flex-1 text-[12.5px] leading-5">{entry.body}</Text>
      </View>
    )
  }
  return (
    <View className="flex-row items-start gap-2.5 rounded-lg border border-info-border bg-info-bg px-3 py-2.5">
      <View className="mt-1.5 h-1.5 w-1.5 rounded-pill bg-info" />
      <View className="flex-1 gap-1">
        <Text className="text-[11px] leading-4 text-info-fg">{entry.body}</Text>
        {entry.meta ? <Text variant="machine" className="text-[9px]">{entry.meta}</Text> : null}
      </View>
    </View>
  )
}

function PlanCard({ plan }: { plan: PlanSummary }) {
  return (
    <Card className="gap-0 p-0">
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-2.5">
        <Text className="text-[11.5px] font-medium">Working plan</Text>
        <Text variant="machine" className="text-[10px]">{plan.progress}</Text>
      </View>
      {plan.rows.map((row) => (
        <View key={row.id} className="flex-row items-start gap-2.5 px-3 py-2.5">
          <View className={cn(
            "mt-0.5 h-[17px] w-[17px] items-center justify-center rounded-pill border",
            markTone[row.tone],
          )}>
            <Text className={cn("font-machine text-[9px]", markTone[row.tone])}>{row.mark}</Text>
          </View>
          <View className="flex-1 gap-1">
            <Text className={cn("text-[12px] leading-4", textTone[row.tone])}>{row.text}</Text>
            <Text variant="machine" className="text-[9px] text-faint">{row.meta}</Text>
          </View>
        </View>
      ))}
      {plan.pendingEdit ? (
        <View className="border-t border-border px-3 py-2.5">
          <Text variant="meta" className="text-[11px]">
            {plan.pendingEdit === "queued"
              ? "An edit to these steps is waiting for the agent to pick it up."
              : "An edit to these steps no longer matches the plan and needs redoing."}
          </Text>
        </View>
      ) : null}
    </Card>
  )
}

export function SessionScreen({
  detail,
  plan,
  pausing,
  onBack,
  onOpenApproval,
  onPause,
}: {
  detail: SessionDetail
  plan: PlanSummary | undefined
  pausing: boolean
  onBack: () => void
  onOpenApproval: (approvalId: string) => void
  onPause: () => void
}) {
  const approvalId = detail.approvalId
  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2 px-2 py-3">
        <Button title="‹" variant="ghost" onPress={onBack} className="px-3" accessibilityLabel="Back to sessions" />
        <View className="flex-1 gap-0.5">
          <Text variant="title" numberOfLines={1}>{detail.title}</Text>
          <Text variant="machine">{detail.runtime}</Text>
        </View>
        <View className="pr-2">
          <Badge label={detail.mode} />
        </View>
      </View>

      <ScrollView contentContainerClassName="gap-3 px-3.5 pb-8">
        {/* The reason the phone was picked up goes above the reading, because
            scrolling a thread to find the decision is the slow path. */}
        {approvalId ? (
          <PressableCard
            className="border-warn-border bg-warn-bg"
            accessibilityLabel="Open the waiting approval"
            onPress={() => onOpenApproval(approvalId)}
          >
            <View className="flex-row items-center gap-2">
              <Text className="flex-1 text-[13px] font-semibold text-warn-fg">
                An approval is waiting
              </Text>
              <Text className="text-[13px] text-warn-fg">›</Text>
            </View>
          </PressableCard>
        ) : null}

        {plan ? <PlanCard plan={plan} /> : null}

        {detail.omitted > 0 ? (
          <Text variant="meta" className="text-center">
            {detail.omitted} earlier item{detail.omitted === 1 ? "" : "s"} are not on this phone.
          </Text>
        ) : null}

        {detail.entries.length === 0
          ? <Text variant="meta">Nothing has been said in this session yet.</Text>
          : null}
        {detail.entries.map((entry) => <Entry key={entry.id} entry={entry} />)}

        <Card className="gap-2">
          <Text variant="label">Session control</Text>
          <Text variant="meta">
            {detail.pausable
              ? "Stops the turn this session is running. Work already done is kept."
              : `Nothing is running to pause. This session is ${detail.state}.`}
          </Text>
          <Button
            title="Pause this session"
            disabled={!detail.pausable || pausing}
            onPress={onPause}
          />
        </Card>
      </ScrollView>
    </View>
  )
}
