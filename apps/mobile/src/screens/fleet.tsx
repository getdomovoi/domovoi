import { View } from "react-native"
import type { FleetEntry } from "@getdomovoi/protocol"

import { ConnectionBanner } from "../components/connection-banner"
import { PageScroller } from "../components/page-scroller"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Text } from "../components/ui/text"
import type { ConnectionNotice } from "../connection-notice"
import { cn } from "../lib/cn"
import type { MachineActivity } from "../machine-activity"
import { fleetSummary, machineRows, type MachineRow } from "../machine-rows"

const dot: Record<MachineRow["health"], string> = {
  ok: "bg-success",
  busy: "bg-warning",
  gone: "bg-destructive",
}

const badgeTone: Record<MachineRow["health"], "neutral" | "warning" | "destructive"> = {
  ok: "neutral",
  busy: "warning",
  gone: "destructive",
}

function PairingCard({ onScan, onType }: { onScan: () => void, onType: () => void }) {
  return (
    <Card className="gap-3 border-info-border bg-info-bg">
      <View>
        <Text className="font-sans-semibold text-[15px] tracking-[-0.01em] text-info-fg">Pair this phone</Text>
        <Text className="mt-[7px] text-[13px] leading-[20px] text-info-dim">
          Pairing exchanges keys with one machine directly, over your tailnet. Nothing passes through a server, and the phone stores no code.
        </Text>
      </View>
      <View className="flex-row gap-2">
        <Button title="Scan a code" variant="info" className="flex-1" onPress={onScan} />
        <Button title="Type it" variant="info-outline" className="flex-1" onPress={onType} />
      </View>
    </Card>
  )
}

function MachineCard({ row, onOpen, onOpenTools }: { row: MachineRow, onOpen: () => void, onOpenTools: () => void }) {
  return (
    // The handoff fades a machine that has stopped answering, so the eye lands
    // on the ones that can still be worked on.
    <Card className={cn(row.health === "gone" && "opacity-60")}>
      <View className="flex-row items-center gap-2.5">
        <View className={cn("h-2 w-2 rounded-full", dot[row.health])} />
        <Text variant="machine" className="flex-1 text-[12px] text-foreground" numberOfLines={1}>
          {row.label}
        </Text>
        <Badge label={row.badge} tone={badgeTone[row.health]} />
      </View>

      <Text variant="note" className="mt-1.5">{row.platform}</Text>
      {row.note ? <Text variant="note" className="mt-1">{row.note}</Text> : null}

      {row.stats.length > 0 || row.action ? (
        // The row wraps, and so do the actions: on a narrow phone or at a large
        // font scale the actions move under the stats, then under each other,
        // rather than run past the card where they cannot be tapped.
        <View className="mt-2 flex-row flex-wrap items-center gap-x-3.5 gap-y-1">
          {row.stats.map((stat) => (
            <View key={stat.label}>
              <Text variant="label" className="tracking-[0.1em]">{stat.label}</Text>
              <Text
                variant="machine"
                className={cn("mt-0.5 text-[10.5px]", stat.attention ? "text-warning" : "text-strong")}
              >
                {stat.value}
              </Text>
            </View>
          ))}
          {/* The Tools screen reads the connected daemon's open repository,
              so it opens from this machine's card and from no other. */}
          {row.action === "open" ? (
            <View className="ml-auto flex-row flex-wrap items-center justify-end gap-x-3.5">
              <Button
                title="Open Tools"
                variant="ghost"
                className="px-0"
                accessibilityLabel={`Tools on ${row.label}`}
                onPress={onOpenTools}
              />
              <Button
                title="Open"
                variant="ghost"
                className="px-0"
                accessibilityLabel={`Open ${row.label}`}
                onPress={onOpen}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </Card>
  )
}

export function MachinesScreen({
  fleet,
  activity,
  loading,
  problem,
  notice,
  connected,
  now,
  onRefresh,
  onOpen,
  onOpenTools,
  onScanPairingCode,
  onTypePairingCode,
  bottomInset,
}: {
  fleet: FleetEntry[] | undefined
  // What the connected daemon is doing. Undefined until a snapshot has arrived,
  // and it describes one machine, so every other row goes without.
  activity: MachineActivity | undefined
  loading: boolean
  problem: string
  notice: ConnectionNotice | undefined
  connected: boolean
  // Passed in rather than read from the clock here, so what the screen draws is
  // a function of what it was given.
  now: number
  onRefresh: () => void
  onOpen: () => void
  // What the connected machine's repository holds back (ruling Q211).
  onOpenTools: () => void
  onScanPairingCode: () => void
  onTypePairingCode: () => void
  // What the floating tab bar covers, so the list can pad by exactly that.
  bottomInset: number
}) {
  const rows = fleet ? machineRows(fleet, now, activity) : []
  const summary = fleet ? fleetSummary(fleet) : undefined
  const empty = fleet !== undefined && rows.length === 0
  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2.5 px-4 pb-3 pt-2">
        <View className="flex-1">
          <Text variant="heading">Machines</Text>
          {summary ? <Text variant="meta" className="mt-[3px]">{summary}</Text> : null}
        </View>
        <Button title="Refresh" onPress={onRefresh} disabled={loading || !connected} />
      </View>

      <PageScroller
        contentContainerClassName={cn("gap-[9px] px-3", empty && "grow justify-center")}
        bottomInset={bottomInset}
      >
        <ConnectionBanner notice={notice} />

        {problem ? <Text variant="meta" className="text-destructive">{problem}</Text> : null}

        {/* Empty, not-yet-asked and not-connected are three different states, and
            saying "no machines" before asking would be a claim the phone has not
            earned. */}
        {!fleet && !problem ? (
          <Text variant="meta">
            {loading
              ? "Asking the daemon."
              : connected
                ? "Waiting to ask the daemon."
                : "The fleet has not been read on this connection."}
          </Text>
        ) : null}
        {empty ? <PairingCard onScan={onScanPairingCode} onType={onTypePairingCode} /> : null}
        {/* A list read before the connection dropped is not a claim about now. */}
        {fleet && rows.length > 0 && !connected
          ? <Text variant="meta">Last read while connected.</Text>
          : null}

        {rows.map((row) => <MachineCard key={row.id} row={row} onOpen={onOpen} onOpenTools={onOpenTools} />)}

        {fleet && !empty ? <PairingCard onScan={onScanPairingCode} onType={onTypePairingCode} /> : null}
      </PageScroller>
    </View>
  )
}
