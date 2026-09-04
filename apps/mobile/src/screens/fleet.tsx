import { ScrollView, View } from "react-native"
import type { FleetMachine } from "@getdomovoi/protocol"

import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Text } from "../components/ui/text"
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
  onRefresh,
}: {
  fleet: FleetMachine[] | undefined
  loading: boolean
  problem: string
  onRefresh: () => void
}) {
  const rows = fleet ? machineRows(fleet) : []
  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-3 p-4 pb-8">
      <View className="flex-row items-center justify-between">
        <Text variant="heading">Fleet</Text>
        <Button title="Refresh" onPress={onRefresh} disabled={loading} />
      </View>

      {problem ? <Text className="text-[12px] text-destructive">{problem}</Text> : null}

      {/* Empty and not-yet-asked are different states, and saying "no machines"
          before asking would be a claim the phone has not earned. */}
      {!fleet && !problem
        ? <Text variant="meta">{loading ? "Asking the daemon." : "Not connected."}</Text>
        : null}
      {fleet && rows.length === 0
        ? <Text variant="meta">No machines are paired with this daemon.</Text>
        : null}

      {rows.map((row) => (
        <Card key={row.id} className="flex-row items-center gap-2.5">
          <View className={cn("h-2 w-2 rounded-pill", dot[row.health])} />
          <View className="flex-1 gap-1">
            <Text variant="title">{row.label}</Text>
            <Text variant="machine">{row.platform}</Text>
          </View>
          {row.badge
            ? <Badge label={row.badge} tone={row.health === "gone" ? "destructive" : "neutral"} />
            : null}
        </Card>
      ))}
    </ScrollView>
  )
}
