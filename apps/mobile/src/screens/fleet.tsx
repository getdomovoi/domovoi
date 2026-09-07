import { ScrollView, View } from "react-native"
import type { FleetEntry } from "@getdomovoi/protocol"

import { ConnectionBanner } from "../components/connection-banner"
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

function MachineCard({ row, onOpen }: { row: MachineRow, onOpen: () => void }) {
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
        <View className="mt-2 flex-row items-center gap-3.5">
          {row.stats.map((stat) => (
            <View key={stat.label}>
              <Text variant="label" className="text-[8.5px] tracking-[0.1em]">{stat.label}</Text>
              <Text
                variant="machine"
                className={cn("mt-0.5 text-[10.5px]", stat.attention ? "text-warning" : "text-strong")}
              >
                {stat.value}
              </Text>
            </View>
          ))}
          {row.action === "open" ? (
            <Button
              title="Open"
              variant="ghost"
              className="ml-auto px-0"
              accessibilityLabel={`Open ${row.label}`}
              onPress={onOpen}
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  )
}

export function FleetScreen({
  fleet,
  activity,
  loading,
  problem,
  notice,
  connected,
  now,
  onRefresh,
  onOpen,
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
  // What the floating tab bar covers, so the list can pad by exactly that.
  bottomInset: number
}) {
  const rows = fleet ? machineRows(fleet, now, activity) : []
  const summary = fleet ? fleetSummary(fleet) : undefined
  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2.5 px-4 pb-3 pt-2">
        <View className="flex-1">
          <Text variant="heading">Fleet</Text>
          {summary ? <Text variant="meta" className="mt-[3px]">{summary}</Text> : null}
        </View>
        <Button title="Refresh" onPress={onRefresh} disabled={loading || !connected} />
      </View>

      <ScrollView
        contentContainerClassName="gap-[9px] px-3"
        contentContainerStyle={{ paddingBottom: bottomInset }}
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
        {fleet && rows.length === 0
          ? <Text variant="meta">No machines are paired with this daemon.</Text>
          : null}
        {/* A list read before the connection dropped is not a claim about now. */}
        {fleet && rows.length > 0 && !connected
          ? <Text variant="meta">Last read while connected.</Text>
          : null}

        {rows.map((row) => <MachineCard key={row.id} row={row} onOpen={onOpen} />)}

        {/* The handoff offers to scan a pairing code here. Enrolling a machine is
            the daemon's to do and no credential reaches a client, so the card says
            where it happens rather than starting something this phone cannot
            finish. */}
        {fleet ? (
          <Card className="border-dashed">
            <Text className="text-[12px]">Pair a machine</Text>
            <Text variant="note" className="mt-1">
              Pairing is done from the desktop on the daemon's machine, which holds the credential.
              This phone reaches one daemon at a time, by the address and pairing token under
              Settings.
            </Text>
          </Card>
        ) : null}
      </ScrollView>
    </View>
  )
}
