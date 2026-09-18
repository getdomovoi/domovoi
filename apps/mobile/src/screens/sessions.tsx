import { RefreshControl, View } from "react-native"
import type { FleetEntry, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { ConnectionBanner } from "../components/connection-banner"
import { PageScroller } from "../components/page-scroller"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { PressableCard } from "../components/ui/card"
import { Icon } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import type { ConnectionNotice } from "../connection-notice"
import { cn } from "../lib/cn"
import { approvalLead, sessionGroups, sessionsHeaderLine, waitingCount, type ApprovalLead, type SessionGroup, type SessionRow } from "../session-rows"
import { colors } from "../theme/tokens.generated"

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
  onOpenStop,
  onRefresh,
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
  onOpenStop: () => void
  onRefresh: () => void
  // What the floating tab bar covers. The list runs underneath it, so the
  // last row is only readable if the scroller pads by what the bar reports.
  bottomInset: number
}) {
  const groups = sessionGroups(snapshot)
  const lead = approvalLead(snapshot, now)
  const needed = waitingCount(snapshot)
  // Leads with how many want a person, because that is what the phone is for.
  // Says nothing when nobody does: a zero here would read as a measurement.
  const countLabel = sessionsHeaderLine(snapshot, fleet)
  const empty = groups.length === 0 && !lead

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2.5 px-4 pb-3 pt-2">
        <View className="flex-1">
          <Text variant="heading">Sessions</Text>
          <Text variant="meta" className="mt-[3px]">
            {needed > 0 ? `${needed} need you · ${countLabel}` : countLabel}
          </Text>
        </View>
        <Button title="Stop everything" onPress={onOpenStop} />
      </View>

      <PageScroller
        contentContainerClassName={cn("gap-[9px] px-3", empty && "grow justify-center")}
        bottomInset={bottomInset}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.dark["muted-foreground"]} />
        }
      >
        <ConnectionBanner notice={notice} />

        {/* This snapshot came from the daemon, so an empty list is a fact about
            the machine rather than a phone that has not been told anything. */}
        {lead ? <ApprovalLeadCard lead={lead} onOpen={onOpenApproval} /> : null}

        {/* Empty is not failure. The daemon answered and has nothing open, so
            the screen says so and names the way to start one. */}
        {empty ? (
          <View className="items-center gap-3 px-6">
            <Icon name="layers" tone="faint" size={24} />
            <Text className="font-sans-medium text-[14.5px] text-foreground">
              No sessions running
            </Text>
            <Text variant="meta" className="text-center leading-[19px]">
              This machine reported in and has nothing open. Start one from the desktop or the
              web app on that machine and it appears here within a second.
            </Text>
          </View>
        ) : null}

        {groups.map((group) => (
          <View key={group.id} className="gap-[9px]">
            <GroupHeading group={group} />
            {group.rows.map((row) => <SessionCard key={row.id} row={row} onOpen={onOpenSession} />)}
          </View>
        ))}
      </PageScroller>
    </View>
  )
}
