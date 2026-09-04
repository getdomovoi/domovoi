import { ScrollView, View } from "react-native"
import type { FleetMachine } from "@getdomovoi/protocol"

import { Badge } from "../components/ui/badge"
import { Card } from "../components/ui/card"
import { Text } from "../components/ui/text"
import { cn } from "../lib/cn"
import { machineRows, type MachineRow } from "../machine-rows"

const dot: Record<MachineRow["health"], string> = {
  ok: "bg-success",
  busy: "bg-warning",
  gone: "bg-destructive",
}

export function FleetScreen({ fleet }: { fleet: FleetMachine[] }) {
  const rows = machineRows(fleet)
  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-3 p-4 pb-8">
      <Text variant="heading">Fleet</Text>
      {rows.length === 0
        ? <Text variant="meta">No machines are paired with this daemon yet.</Text>
        : rows.map((row) => (
          <Card key={row.id} className="flex-row items-center gap-2.5">
            <View className={cn("h-2 w-2 rounded-pill", dot[row.health])} />
            <View className="flex-1 gap-1">
              <Text variant="title">{row.label}</Text>
              <Text variant="machine">{row.platform}</Text>
            </View>
            {row.badge ? <Badge label={row.badge} tone={row.health === "gone" ? "destructive" : "neutral"} /> : null}
          </Card>
        ))}
    </ScrollView>
  )
}
