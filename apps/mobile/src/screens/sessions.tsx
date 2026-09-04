import { ScrollView, View } from "react-native"
import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, PressableCard } from "../components/ui/card"
import { Text } from "../components/ui/text"
import { cn } from "../lib/cn"
import { sessionRows, waitingCount, type SessionRow } from "../session-rows"

const dotColour: Record<SessionRow["dot"], string> = {
  active: "bg-success",
  waiting: "bg-warning",
  quiet: "bg-faint",
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
  onOpenSession,
  onPauseAll,
}: {
  snapshot: WorkspaceSnapshot
  // Unknown until the fleet has been asked, and a phone claiming one machine
  // because it has only counted the one it is talking to is a lie on screen.
  machineCount: number | undefined
  onOpenSession: (sessionId: string) => void
  onPauseAll: () => void
}) {
  const rows = sessionRows(snapshot)
  const waiting = waitingCount(snapshot)
  const running = snapshot.sessions.filter((session) => session.state === "active").length

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-3 p-4 pb-8">
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

      {waiting > 0 ? (
        <Card className="border-warn-border bg-warn-bg">
          <Text className="text-[13px] font-semibold text-warn-fg">
            {waiting} approval{waiting === 1 ? "" : "s"} waiting
          </Text>
        </Card>
      ) : null}

      {rows.map((row) => <SessionCard key={row.id} row={row} onOpen={onOpenSession} />)}
    </ScrollView>
  )
}
