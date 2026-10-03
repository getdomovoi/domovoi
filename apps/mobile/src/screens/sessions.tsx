import { RefreshControl, View } from "react-native"
import type { FleetEntry, WorkspaceSnapshot } from "@getdomovoi/protocol"

import { ConnectionBanner } from "../components/connection-banner"
import { Mark } from "../components/mark"
import { PageScroller } from "../components/page-scroller"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, PressableCard } from "../components/ui/card"
import { Text } from "../components/ui/text"
import type { ConnectionNotice } from "../connection-notice"
import { sessionsGateReach } from "../gate-reach"
import { cn } from "../lib/cn"
import { machineRows, type MachineRow } from "../machine-rows"
import { elapsedLabel, sessionGroups, sessionsHeaderLine, waitingCount, type SessionRow } from "../session-rows"
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
function GroupHeading({ label, count }: { label: string, count: number }) {
  return (
    <View className="mt-1 flex-row items-center px-1">
      <Text className="flex-1 font-sans-medium text-label uppercase tracking-[0.08em] text-faint">
        {label}
      </Text>
      <Text variant="machine" className="text-faint">{count}</Text>
    </View>
  )
}

// When a machine was last heard from, in the design's words (frame 10).
function lastSeen(iso: string, now: number): string | undefined {
  const age = elapsedLabel(iso, now)
  if (age === undefined) return undefined
  return age === "now" ? "last seen just now" : `last seen ${age} ago`
}

// Ruling Q358 A: the design's UNREACHABLE group, drawn as the machines that do
// not answer. The phone holds no sessions from them, so it names the machine
// and when it was last seen rather than inventing session cards.
function UnreachableMachines({ fleet, now }: { fleet: FleetEntry[], now: number }) {
  const silent = fleet.flatMap((entry) =>
    entry.kind === "machine" && (entry.machine.health === "unreachable" || entry.machine.health === "degraded")
      ? [entry.machine]
      : [])
  if (silent.length === 0) return null
  return (
    <View className="gap-[9px]">
      <GroupHeading label="UNREACHABLE" count={silent.length} />
      {silent.map((machine) => (
        <Card key={machine.id} className="flex-row items-center gap-2.5 opacity-55">
          <View className="h-[7px] w-[7px] rounded-full bg-faint" />
          <Text className="flex-1 font-mono text-[12.5px] text-strong" numberOfLines={1}>{machine.label}</Text>
          <Text className="shrink font-sans text-[11.5px] text-faint" numberOfLines={1}>
            {lastSeen(machine.heartbeat.lastSeenAt, now) ?? "not answering"}
          </Text>
        </Card>
      ))}
    </View>
  )
}

// The idle card's sentence, from what the phone was given. The count comes
// from the fleet's health; with no fleet read yet it is the one machine the
// phone talks to. Idleness is vouched for only for that machine, because
// fleet.list carries no other machine's sessions.
function idleSentence(machine: string, fleet: FleetEntry[] | undefined): string {
  const answering = fleet
    ? fleet.filter((entry) => entry.kind === "machine" && entry.machine.health === "healthy").length
    : 1
  const lead = answering <= 1
    ? `${machine} is answering and has no work in flight.`
    : `${answering} machines are answering. ${machine}, the one this phone reads, has no work in flight.`
  return `${lead} Empty here is a healthy state, not a failure.`
}

const fleetDot: Record<MachineRow["health"], string> = {
  ok: "bg-success",
  busy: "bg-warning",
  gone: "bg-faint",
}

// Frame 10's fleet rows: each machine, its light, and how it is reached or
// when it was last seen. A machine that has stopped answering is dimmed. The
// state is a few words on one line that gives way to the name, because the
// row's note is a sentence that repeats the name and crowded it out.
function IdleFleet({ fleet, now }: { fleet: FleetEntry[], now: number }) {
  const rows = machineRows(fleet, now)
  if (rows.length === 0) return null
  return (
    <View className="overflow-hidden rounded-2xl border border-border">
      {rows.map((row, index) => {
        const entry = fleet[index]
        const state = row.health === "gone" && entry?.kind === "machine"
          ? lastSeen(entry.machine.heartbeat.lastSeenAt, now) ?? row.badge
          : row.badge
        return (
          <View
            key={row.id}
            className={cn(
              "min-h-[52px] flex-row items-center gap-[11px] bg-card px-[15px] py-3",
              index > 0 && "border-t border-border",
              row.health === "gone" && "opacity-55",
            )}
          >
            <View className={cn("h-[7px] w-[7px] rounded-full", fleetDot[row.health])} />
            <Text className="flex-1 font-mono text-[12.5px] text-strong" numberOfLines={1}>{row.label}</Text>
            <Text className="max-w-[50%] shrink font-sans text-[11.5px] text-faint" numberOfLines={1}>{state}</Text>
          </View>
        )
      })}
    </View>
  )
}

function SessionCard({ row, approvalId, now, onOpen, onOpenApproval }: {
  row: SessionRow
  approvalId: string | undefined
  now: number
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
        {[row.machine, row.waitingSince ? elapsedLabel(row.waitingSince, now) : undefined]
          .filter((part) => part !== undefined)
          .join(" · ")}
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
  const { palette } = useTheme()
  const groups = sessionGroups(snapshot)
  const needed = waitingCount(snapshot)
  const countLabel = sessionsHeaderLine(snapshot, fleet)
  const empty = groups.length === 0

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2.5 px-4 pb-3 pt-2">
        <View className="flex-1">
          <View className="flex-row items-center gap-[11px]">
            <Mark size={24} />
            <Text variant="heading">Sessions</Text>
          </View>
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
                {idleSentence(snapshot.machine.name, fleet)}
              </Text>
            </Card>
            {fleet ? <IdleFleet fleet={fleet} now={now} /> : null}
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
            <GroupHeading label={group.label} count={group.rows.length} />
            {group.rows.map((row) => (
              <SessionCard
                key={row.id}
                row={row}
                approvalId={snapshot.approvals.find((approval) => approval.sessionId === row.id)?.id}
                now={now}
                onOpen={onOpenSession}
                onOpenApproval={onOpenApproval}
              />
            ))}
          </View>
        ))}

        {/* With nothing listed, the idle card's fleet rows already name the
            machines that do not answer. */}
        {!empty && fleet ? <UnreachableMachines fleet={fleet} now={now} /> : null}
      </PageScroller>
    </View>
  )
}
