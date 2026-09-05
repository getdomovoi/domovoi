import { ScrollView, View } from "react-native"
import type { FleetEntry } from "@getdomovoi/protocol"

import { ConnectionBanner } from "../components/connection-banner"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Text } from "../components/ui/text"
import type { ConnectionNotice } from "../connection-notice"
import { cn } from "../lib/cn"
import { machineRows, type MachineRow } from "../machine-rows"

const dot: Record<MachineRow["health"], string> = {
  ok: "bg-success",
  busy: "bg-warning",
  gone: "bg-destructive",
}

export function FleetScreen({
  fleet,
  loading,
  problem,
  notice,
  connected,
  onRefresh,
}: {
  fleet: FleetEntry[] | undefined
  loading: boolean
  problem: string
  notice: ConnectionNotice | undefined
  connected: boolean
  onRefresh: () => void
}) {
  const rows = fleet ? machineRows(fleet) : []
  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-3 p-4 pb-8">
      <View className="flex-row items-center justify-between">
        <Text variant="heading">Fleet</Text>
        <Button title="Refresh" onPress={onRefresh} disabled={loading || !connected} />
      </View>

      <ConnectionBanner notice={notice} />

      {problem ? <Text className="text-[12px] text-destructive">{problem}</Text> : null}

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

      {rows.map((row) => (
        <Card key={row.id} className="flex-row items-center gap-2.5">
          <View className={cn("h-2 w-2 rounded-full", dot[row.health])} />
          <View className="flex-1 gap-1">
            <Text variant="title">{row.label}</Text>
            <Text variant="machine">{row.platform}</Text>
            {row.note ? <Text variant="meta">{row.note}</Text> : null}
          </View>
          {row.badge
            ? <Badge label={row.badge} tone={row.health === "gone" ? "destructive" : "neutral"} />
            : null}
        </Card>
      ))}
    </ScrollView>
  )
}
