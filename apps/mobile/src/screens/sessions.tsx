import { RefreshControl, ScrollView, View } from "react-native"
import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import { ConnectionBanner } from "../components/connection-banner"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, PressableCard } from "../components/ui/card"
import { Text } from "../components/ui/text"
import type { ConnectionNotice } from "../connection-notice"
import { cn } from "../lib/cn"
import { approvalLead, sessionRows, type ApprovalLead, type SessionRow } from "../session-rows"
import { colors } from "../theme/tokens.generated"

const dotColour: Record<SessionRow["dot"], string> = {
  active: "bg-success",
  waiting: "bg-warning",
  quiet: "bg-faint",
}

const attentionColour: Record<"approval" | "preview", string> = {
  approval: "text-warning",
  preview: "text-primary",
}

// The handoff leads the screen with this: the command, where it would run, and
// how long it has been sitting there. A count alone tells a person that
// something needs them without telling them what, which costs the scroll this
// card exists to save.
function ApprovalLeadCard({ lead, onOpen }: {
  lead: ApprovalLead
  onOpen: (approvalId: string) => void
}) {
  return (
    <PressableCard
      className="border-warn-border bg-warn-bg"
      accessibilityLabel={`${lead.headline}. ${lead.command}`}
      onPress={() => onOpen(lead.approvalId)}
    >
      <View className="flex-row items-center gap-2.5">
        <View className="h-[7px] w-[7px] rounded-full bg-warning" />
        <Text className="flex-1 font-sans-medium text-[12.5px] text-warn-fg">{lead.headline}</Text>
        {lead.waited
          ? <Text variant="machine" className="text-warn-dim">{lead.waited}</Text>
          : null}
      </View>
      <Text variant="machine" className="mt-[7px] text-[11px] leading-[16px] text-warn-fg">
        {lead.command}
      </Text>
      <Text variant="note" className="mt-[5px] text-warn-dim">{lead.context}</Text>
    </PressableCard>
  )
}

function SessionCard({ row, onOpen }: { row: SessionRow, onOpen: (id: string) => void }) {
  return (
    <PressableCard onPress={() => onOpen(row.id)} accessibilityLabel={row.title}>
      <View className="flex-row items-start gap-2.5">
        <View className={cn("mt-[5px] h-[7px] w-[7px] rounded-full", dotColour[row.dot])} />
        <Text variant="title" className="flex-1">{row.title}</Text>
      </View>
      {/* Indented past the dot and its gap, so the facts hang under the title
          rather than under the state light. */}
      <View className="mt-2 flex-row flex-wrap items-center gap-[5px] pl-[17px]">
        <Badge label={row.runtime} />
        <Badge label={row.mode} tone="outline" />
        {row.attention ? (
          <Text className={cn(
            "ml-auto font-sans-medium text-[9.5px] uppercase tracking-[0.06em]",
            attentionColour[row.attention],
          )}>
            {row.attention}
          </Text>
        ) : null}
      </View>
      <Text variant="machine" className="mt-[5px] pl-[17px] text-[9.5px] text-faint">
        {row.machine}
      </Text>
    </PressableCard>
  )
}

export function SessionsScreen({
  snapshot,
  machineCount,
  notice,
  refreshing,
  now,
  onOpenSession,
  onOpenApproval,
  onPauseAll,
  onRefresh,
  bottomInset,
}: {
  snapshot: WorkspaceSnapshot
  // Unknown until the fleet has been asked, and a phone claiming one machine
  // because it has only counted the one it is talking to is a lie on screen.
  machineCount: number | undefined
  notice: ConnectionNotice | undefined
  refreshing: boolean
  // Passed in rather than read from the clock here, so what the screen draws is
  // a function of what it was given.
  now: number
  onOpenSession: (sessionId: string) => void
  onOpenApproval: (approvalId: string) => void
  onPauseAll: () => void
  onRefresh: () => void
  // What the floating tab bar covers. The list runs underneath it, so the
  // last row is only readable if the scroller pads by what the bar reports.
  bottomInset: number
}) {
  const rows = sessionRows(snapshot)
  const lead = approvalLead(snapshot, now)
  const running = snapshot.sessions.filter((session) => session.state === "active").length

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2.5 px-4 pb-3 pt-2">
        <View className="flex-1">
          <Text variant="heading">Sessions</Text>
          <Text variant="meta" className="mt-[3px]">
            {machineCount === undefined
              ? `${running} running`
              : `${machineCount} machine${machineCount === 1 ? "" : "s"} · ${running} running`}
          </Text>
        </View>
        <Button title="Pause all" onPress={onPauseAll} />
      </View>

      <ScrollView
        contentContainerClassName="gap-[9px] px-3"
        contentContainerStyle={{ paddingBottom: bottomInset }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.dark["muted-foreground"]} />
        }
      >
        <ConnectionBanner notice={notice} />

        {/* This snapshot came from the daemon, so an empty list is a fact about
            the machine rather than a phone that has not been told anything. */}
        {lead ? <ApprovalLeadCard lead={lead} onOpen={onOpenApproval} /> : null}

        {rows.length === 0 ? (
          <Card className="border-dashed">
            <Text variant="meta">
              No sessions on this machine. Start one from the desktop.
            </Text>
          </Card>
        ) : null}

        {rows.map((row) => <SessionCard key={row.id} row={row} onOpen={onOpenSession} />)}
      </ScrollView>
    </View>
  )
}
