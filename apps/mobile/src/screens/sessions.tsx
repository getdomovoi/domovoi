import { RefreshControl, View } from "react-native"
import type { FleetEntry, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { ConnectionBanner } from "../components/connection-banner"
import { PageScroller } from "../components/page-scroller"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, PressableCard } from "../components/ui/card"
import { Text } from "../components/ui/text"
import type { ConnectionNotice } from "../connection-notice"
import { sessionsGateReach } from "../gate-reach"
import { cn } from "../lib/cn"
import { sessionGroups, sessionsHeaderLine, waitingCount, type SessionGroup, type SessionRow } from "../session-rows"
import { useTheme } from "../theme/theme-provider"

const dotColour: Record<SessionRow["dot"], string> = {
  active: "bg-success",
  waiting: "bg-warning",
  quiet: "bg-faint",
}

// Keyed by the row's own type rather than restating its two values. A third
// kind of attention already failed at the indexed lookup below; keying the
// table moves that failure to this declaration, where the omission is.
const attentionColour: Record<NonNullable<SessionRow["attention"]>, string> = {
  approval: "text-warning",
  preview: "text-primary",
}

// A heading is a label and a count, the way the design draws it. The count is
// the group's own size, so a heading never says more than the cards under it.
function GroupHeading({ group }: { group: SessionGroup }) {
  return (
    <View className="mt-1 flex-row items-center px-1">
      <Text className="flex-1 font-sans-medium text-label uppercase tracking-[0.08em] text-faint">
        {group.label}
      </Text>
      <Text variant="machine" className="text-faint">{group.rows.length}</Text>
    </View>
  )
}

function SessionCard({ row, approvalId, onOpen, onOpenApproval }: {
  row: SessionRow
  approvalId: string | undefined
  onOpen: (id: string) => void
  onOpenApproval: (id: string) => void
}) {
  return (
    <PressableCard
      onPress={() => approvalId ? onOpenApproval(approvalId) : onOpen(row.id)}
      accessibilityLabel={row.title}
    >
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
            "ml-auto font-sans-medium text-label uppercase tracking-[0.06em]",
            attentionColour[row.attention],
          )}>
            {row.attention}
          </Text>
        ) : null}
      </View>
      <Text variant="machine" className="mt-[5px] pl-[17px] text-faint">
        {row.machine}
      </Text>
    </PressableCard>
  )
}

export function SessionsScreen({
  snapshot,
  fleet,
  notice,
  refreshing,
  now,
  onOpenSession,
  onOpenApproval,
  onRefresh,
  onStartSession,
  startDisabledReason,
  bottomInset,
}: {
  snapshot: WorkspaceSnapshot
  // The fleet list from this daemon, once it has been asked. Used only to say
  // how many machines answered; the sessions here are this machine's, and a
  // phone claiming a fleet count from the one machine it talks to is a lie.
  fleet: FleetEntry[] | undefined
  notice: ConnectionNotice | undefined
  refreshing: boolean
  // Passed in rather than read from the clock here, so what the screen draws is
  // a function of what it was given.
  now: number
  onOpenSession: (sessionId: string) => void
  onOpenApproval: (approvalId: string) => void
  onRefresh: () => void
  onStartSession: () => void
  startDisabledReason: string | undefined
  // What the floating tab bar covers. The list runs underneath it, so the
  // last row is only readable if the scroller pads by what the bar reports.
  bottomInset: number
}) {
  void now
  const { palette } = useTheme()
  const groups = sessionGroups(snapshot)
  const needed = waitingCount(snapshot)
  const countLabel = sessionsHeaderLine(snapshot, fleet)
  const empty = groups.length === 0

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2.5 px-4 pb-3 pt-2">
        <View className="flex-1">
          <Text variant="heading">Sessions</Text>
          <Text variant="meta" className="mt-[3px]">
            {needed > 0 ? `${needed} need you · ${countLabel}` : countLabel}
          </Text>
        </View>
      </View>

      <PageScroller
        contentContainerClassName={cn("gap-[9px] px-3", empty && "grow justify-center")}
        bottomInset={bottomInset}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette["muted-foreground"]} />
        }
      >
        <ConnectionBanner notice={notice} />

        <View className="flex-row items-start gap-[9px] px-1">
          <View className="mt-1.5 h-1.5 w-1.5 rounded-full bg-info" />
          <Text variant="meta" className="flex-1">{sessionsGateReach}</Text>
        </View>

        {empty ? (
          <View className="gap-3 px-3">
            <Card className="gap-2 border-ok-border bg-ok-bg">
              <Text variant="title" className="text-ok-fg">Everything is idle</Text>
              <Text variant="meta" className="text-ok-dim">
                Two machines are answering and neither has work in flight. Empty here is a healthy state, not a failure.
              </Text>
            </Card>
            <Button
              title="Start a session"
              variant="primary"
              shape="block"
              disabled={startDisabledReason !== undefined}
              onPress={onStartSession}
            />
            {startDisabledReason ? <Text variant="note" className="text-center">{startDisabledReason}</Text> : null}
          </View>
        ) : null}

        {groups.map((group) => (
          <View key={group.id} className="gap-[9px]">
            <GroupHeading group={group} />
            {group.rows.map((row) => (
              <SessionCard
                key={row.id}
                row={row}
                approvalId={snapshot.approvals.find((approval) => approval.sessionId === row.id)?.id}
                onOpen={onOpenSession}
                onOpenApproval={onOpenApproval}
              />
            ))}
          </View>
        ))}
      </PageScroller>
    </View>
  )
}
