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
import { elapsedLabel, needsYouLabel, sessionGroups, sessionsHeaderLine, waitingCount, type SessionGroupId, type SessionRow } from "../session-rows"
import { useTheme } from "../theme/theme-provider"

const dotColour: Record<SessionRow["dot"], string> = {
  active: "bg-success",
  waiting: "bg-warning",
  quiet: "bg-faint",
}

// Frame 01 tints each group's count with the group's state: amber for what
// wants you, green for what runs, muted for the rest.
type GroupTone = "warning" | "success" | "muted"

const countTone: Record<GroupTone, { box: string, label: string }> = {
  warning: { box: "bg-warning/15", label: "text-warning" },
  success: { box: "bg-success/15", label: "text-success" },
  muted: { box: "bg-muted", label: "text-muted-foreground" },
}

const groupTone: Record<SessionGroupId | "unreachable", GroupTone> = {
  "needs-you": "warning",
  running: "success",
  quiet: "muted",
  unreachable: "muted",
}

// A heading is a label and a count, the way the design draws it. The count is
// the group's own size, so a heading never says more than the cards under it.
// Green says the sessions under it run now, so while the phone is not live a
// green count goes muted, as the card lights do.
function GroupHeading({ id, label, count, live = true }: { id: SessionGroupId | "unreachable", label: string, count: number, live?: boolean }) {
  const tone = countTone[!live && groupTone[id] === "success" ? "muted" : groupTone[id]]
  return (
    <View className="mt-1 flex-row items-center px-1">
      <Text className="flex-1 font-sans-medium text-label uppercase tracking-[0.08em] text-faint">
        {label}
      </Text>
      <View testID={`group-count-${id}`} className={cn("min-w-[20px] items-center rounded-full px-2 py-0.5", tone.box)}>
        <Text variant="machine" className={tone.label}>{count}</Text>
      </View>
    </View>
  )
}

// Frame 01 draws what a session wants from you as a small pill on the card:
// gate for an approval in amber. A preview keeps the primary colour it had.
const attentionPill: Record<NonNullable<SessionRow["attention"]>, { text: string, box: string, label: string }> = {
  approval: { text: "gate", box: "bg-warning/15", label: "text-warning" },
  preview: { text: "preview", box: "bg-primary/15", label: "text-primary" },
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
      <GroupHeading id="unreachable" label="UNREACHABLE" count={silent.length} />
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
// fleet.list carries no other machine's sessions. While a connection notice is
// up, what was read may no longer hold, so the count goes and the sentence
// speaks of the last read. The tablet's empty thread pane says the same.
export function idleSentence(machine: string, fleet: FleetEntry[] | undefined, stale: boolean): string {
  if (stale) return `${machine} had no work in flight when last read.`
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
//
// A green light says a machine answers now. While the connection is down the
// fleet was read before the drop, so every light goes faint.
function IdleFleet({ fleet, now, stale }: { fleet: FleetEntry[], now: number, stale: boolean }) {
  const rows = machineRows(fleet, now)
  if (rows.length === 0) return null
  return (
    <View className="overflow-hidden rounded-2xl border border-border">
      {rows.map((row, index) => {
        const entry = fleet[index]
        // Only a machine that does not answer is described by when it was
        // last seen. One that answered with a demand (pair again, update)
        // says the demand.
        const silent = entry?.kind === "machine"
          && (entry.machine.health === "unreachable" || entry.machine.health === "degraded")
        const state = silent
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
            <View testID="fleet-dot" className={cn("h-[7px] w-[7px] rounded-full", stale ? "bg-faint" : fleetDot[row.health])} />
            <Text className="flex-1 font-mono text-[12.5px] text-strong" numberOfLines={1}>{row.label}</Text>
            <Text className="max-w-[50%] shrink font-sans text-[11.5px] text-faint" numberOfLines={1}>{state}</Text>
          </View>
        )
      })}
    </View>
  )
}

function SessionCard({ row, approvalId, now, live, onOpen, onOpenApproval }: {
  row: SessionRow
  approvalId: string | undefined
  now: number
  // A card's light says what the session does now. Drawn from the last state
  // while the phone is not live, every light goes faint. The approval ground
  // and pill stay: they are the last fact the phone holds about the gate.
  live: boolean
  onOpen: (id: string) => void
  onOpenApproval: (id: string) => void
}) {
  const pill = row.attention ? attentionPill[row.attention] : undefined
  return (
    <PressableCard
      onPress={() => approvalId ? onOpenApproval(approvalId) : onOpen(row.id)}
      accessibilityLabel={row.title}
      // Frame 01: a card that needs you sits on the warning ground.
      className={cn(row.attention === "approval" && "border-warn-border bg-warn-bg")}
    >
      <View className="flex-row items-start gap-2.5">
        <View testID="session-dot" className={cn("mt-[5px] h-[7px] w-[7px] rounded-full", live ? dotColour[row.dot] : dotColour.quiet)} />
        <Text variant="title" className="flex-1">{row.title}</Text>
        {pill ? (
          <View className={cn("rounded-full px-2 py-0.5", pill.box)}>
            <Text variant="machine" className={pill.label}>{pill.text}</Text>
          </View>
        ) : null}
      </View>
      {/* Indented past the dot and its gap, so the facts hang under the title
          rather than under the state light. */}
      <View className="mt-2 flex-row flex-wrap items-center gap-[5px] pl-[17px]">
        <Badge label={row.runtime} />
        <Badge label={row.mode} tone="outline" />
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
  live,
  lastReadAt,
  refreshing,
  now,
  fleetNow,
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
  // Whether the daemon has answered this connection's hello and it is still
  // open. False while not connected, refused, or not yet answered: the list is
  // then the last state the phone was sent, and the header and lights say so.
  live: boolean
  // The phone's clock when that state arrived, if known.
  lastReadAt: number | undefined
  refreshing: boolean
  // Passed in rather than read from the clock here, so what the screen draws is
  // a function of what it was given. How long a session has waited on you.
  now: number
  // The daemon's time now, by the offset kept with the fleet. A heartbeat's
  // time is the daemon's, so how long a machine has been silent is measured
  // on this clock rather than the phone's.
  fleetNow: number
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
  const countLabel = sessionsHeaderLine(snapshot, fleet, live ? undefined : { readAt: lastReadAt, now })
  const empty = groups.length === 0

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2.5 px-4 pb-3 pt-2">
        <View className="flex-1">
          <View className="flex-row items-center gap-[11px]">
            <Mark size={24} />
            <Text variant="heading" className="flex-1">Sessions</Text>
            {/* Frame 01: how many sessions need you is the header's pill. */}
            {needed > 0 ? (
              <View testID="needs-you-pill" className="rounded-full bg-warn-bg px-2.5 py-1">
                <Text className="font-sans-medium text-[11.5px] text-warn-fg">{needsYouLabel(needed)}</Text>
              </View>
            ) : null}
          </View>
          <Text variant="meta" className="mt-[3px]">{countLabel}</Text>
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
                {idleSentence(snapshot.machine.name, fleet, notice !== undefined)}
              </Text>
            </Card>
            {fleet ? <IdleFleet fleet={fleet} now={fleetNow} stale={notice !== undefined} /> : null}
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
            <GroupHeading id={group.id} label={group.label} count={group.rows.length} live={live} />
            {group.rows.map((row) => (
              <SessionCard
                key={row.id}
                row={row}
                approvalId={snapshot.approvals.find((approval) => approval.sessionId === row.id && approval.requestedAt === row.waitingSince)?.id}
                now={now}
                live={live}
                onOpen={onOpenSession}
                onOpenApproval={onOpenApproval}
              />
            ))}
          </View>
        ))}

        {/* With nothing listed, the idle card's fleet rows already name the
            machines that do not answer. */}
        {!empty && fleet ? <UnreachableMachines fleet={fleet} now={fleetNow} /> : null}
      </PageScroller>
    </View>
  )
}
