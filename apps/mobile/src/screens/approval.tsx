import { ScrollView, View } from "react-native"
import type { ApprovalRequest } from "@getdomovoi/protocol"

import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Text } from "../components/ui/text"

// The facts the handoff puts on this screen, in its order. A decision made
// without them is a decision made blind, so none of them are behind a tap.
function facts(approval: ApprovalRequest): Array<{ key: string, value: string, tone?: string }> {
  return [
    { key: "Machine", value: approval.machine },
    { key: "Agent", value: approval.agent },
    { key: "Mode", value: approval.mode },
    { key: "Directory", value: approval.directory },
    { key: "Affects", value: approval.affects, tone: "text-warning" },
    { key: "Network", value: approval.network },
  ]
}

export function ApprovalScreen({
  approval,
  pending,
  onDecide,
  onBack,
}: {
  approval: ApprovalRequest
  pending: boolean
  onDecide: (decision: "allow-once" | "deny") => void
  onBack: () => void
}) {
  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-3 px-4 py-3">
        <Button title="Back" variant="ghost" onPress={onBack} className="px-2" />
        <View className="flex-1">
          <Text variant="title">Approval</Text>
          <Text variant="machine">{approval.machine}</Text>
        </View>
        {approval.risk === "hard-gate" ? <Badge label="Hard gate" tone="warning" /> : null}
      </View>

      <ScrollView contentContainerClassName="gap-3 px-4 pb-8">
        <Card className="bg-code">
          <Text className="font-mono text-[12px] text-foreground">{approval.command}</Text>
        </Card>

        <Card className="gap-0 p-0">
          {facts(approval).map((fact, index) => (
            <View
              key={fact.key}
              className={`flex-row items-center justify-between px-3.5 py-3 ${index > 0 ? "border-t border-border" : ""}`}
            >
              <Text variant="label">{fact.key}</Text>
              <Text className={`font-mono text-[11px] ${fact.tone ?? "text-strong"}`}>
                {fact.value}
              </Text>
            </View>
          ))}
        </Card>

        <View className="gap-2 pt-2">
          <Button
            title="Allow once"
            variant="primary"
            disabled={pending}
            onPress={() => onDecide("allow-once")}
          />
          <Button
            title="Deny"
            variant="destructive"
            disabled={pending}
            onPress={() => onDecide("deny")}
          />
        </View>
      </ScrollView>
    </View>
  )
}
