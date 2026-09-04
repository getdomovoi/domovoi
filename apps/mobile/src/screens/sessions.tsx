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

const dotColour: Record<SessionRow["dot"], string> = {
  active: "bg-success",
  waiting: "bg-warning",
  quiet: "bg-faint",
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
      className="gap-2 border-warn-border bg-warn-bg"
      accessibilityLabel={`${lead.headline}. ${lead.command}`}
      onPress={() => onOpen(lead.approvalId)}
    >
      <View className="flex-row items-center gap-2.5">
        <View className="h-[7px] w-[7px] rounded-pill bg-warning" />
        <Text className="flex-1 text-[12.5px] font-medium text-warn-fg">{lead.headline}</Text>
        {lead.waited
          ? <Text variant="machine" className="text-[10px] text-warn-dim">{lead.waited}</Text>
          : null}
      </View>
      <Text variant="machine" className="text-[11px] text-warn-fg">{lead.command}</Text>
      <Text className="text-[10.5px] text-warn-dim">{lead.context}</Text>
    </PressableCard>
  )
}

function SessionCard({ row, onOpen }: { row: SessionRow, onOpen: (id: string) => void }) {
  return (
    <PressableCard onPress={() => onOpen(row.id)} accessibilityLabel={row.title}>
      <View className="flex-row items-start gap-2.5">
        <View className={cn("mt-1.5 h-2 w-2 rounded-pill", dotColour[row.dot])} />
        <View className="flex-1 gap-2">
          <Text variant="title">{row.title}</Text>
          <View className="flex-row flex-wrap items-center gap-1.5">
            <Badge label={row.runtime} />
            <Badge label={row.mode} />
            {row.attention ? (
              <Text className={cn(
                "ml-auto font-machine text-[10px] uppercase tracking-[0.06em]",
                row.attention === "approval" ? "text-warning" : "text-primary",
              )}>
                {row.attention}
              </Text>
            ) : null}
          </View>
          <Text variant="machine">{row.machine}</Text>
        </View>
      </View>
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
}) {
  const rows = sessionRows(snapshot)
  const lead = approvalLead(snapshot, now)
  const running = snapshot.sessions.filter((session) => session.state === "active").length

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-3 p-4 pb-8"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#919198" />
      }
    >
      <View className="flex-row items-center justify-between">
        <View className="gap-1">
          <Text variant="heading">Sessions</Text>
          <Text variant="meta">
            {machineCount === undefined
              ? `${running} running`
              : `${machineCount} machine${machineCount === 1 ? "" : "s"} · ${running} running`}
          </Text>
        </View>
        <Button title="Pause all" onPress={onPauseAll} />
      </View>

      <ConnectionBanner notice={notice} />

      {lead ? <ApprovalLeadCard lead={lead} onOpen={onOpenApproval} /> : null}

      {/* This snapshot came from the daemon, so an empty list is a fact about
          the machine rather than a phone that has not been told anything. */}
      {rows.length === 0 ? (
        <Card>
          <Text variant="meta">
            No sessions on this machine. Start one from the desktop.
          </Text>
        </Card>
      ) : null}

      {rows.map((row) => <SessionCard key={row.id} row={row} onOpen={onOpenSession} />)}
    </ScrollView>
  )
}
