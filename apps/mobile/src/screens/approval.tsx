import { useState } from "react"
import { Pressable, ScrollView, View } from "react-native"
import type { ApprovalRequest } from "@getdomovoi/protocol"

import { FloatingBar } from "../components/floating-bar"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Icon } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import { cn } from "../lib/cn"

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
    { key: "Estimated", value: approval.estimatedDuration },
    { key: "Checkpoint", value: approval.checkpoint },
  ]
}

export function ApprovalScreen({
  approval,
  pending,
  onDecide,
  onDenyExplain,
  onBack,
}: {
  approval: ApprovalRequest
  pending: boolean
  onDecide: (decision: "allow-once" | "deny") => void
  // Denying with a reason is a second screen rather than a second tap, because
  // the reason is the only thing the agent is given and it has to be written.
  onDenyExplain: () => void
  onBack: () => void
}) {
  const [footprint, setFootprint] = useState(0)
  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2.5 px-3.5 pb-3 pt-1.5">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={onBack}
          className="min-h-tap min-w-tap -ml-3 items-center justify-center active:opacity-70"
        >
          <Icon name="chevron-left" tone="primary" />
        </Pressable>
        <View className="flex-1">
          <Text variant="nav" numberOfLines={1}>Approval</Text>
          <Text variant="machine">{approval.machine}</Text>
        </View>
        {approval.risk === "hard-gate" ? <Badge label="Hard gate" tone="warning" pill /> : null}
      </View>

      <ScrollView
        contentContainerClassName="gap-3 px-3.5"
        contentContainerStyle={{ paddingBottom: footprint }}
      >
        <Text variant="body">{approval.operation}</Text>

        <Card className="bg-code px-3.5 py-3.5">
          <Text variant="machine" className="text-[12px] leading-[19px] text-warn-fg">
            {approval.command}
          </Text>
        </Card>

        <Card flush>
          {facts(approval).map((fact, index) => (
            <View
              key={fact.key}
              className={cn(
                "flex-row items-baseline gap-2.5 px-[13px] py-2.5",
                index > 0 && "border-t border-border",
              )}
            >
              <Text variant="label" className="w-24">{fact.key}</Text>
              <Text
                variant="machine"
                className={cn("flex-1 text-right text-[11px]", fact.tone ?? "text-strong")}
              >
                {fact.value}
              </Text>
            </View>
          ))}
        </Card>
      </ScrollView>

      {/* The decision sits in thumb reach at the foot of the screen rather than
          at the end of a scroll, and the affirmative one wears the warning the
          request wears, so neither answer reads as the safe default. */}
      <FloatingBar shape="decision" padding="stack" lifted onFootprint={setFootprint}>
        <Button
          title="Allow once"
          variant="affirm"
          shape="wide"
          disabled={pending}
          onPress={() => onDecide("allow-once")}
        />
        <View className="flex-row gap-2">
          <Button
            title="Deny"
            variant="outline"
            shape="wide"
            className="flex-1"
            disabled={pending}
            onPress={() => onDecide("deny")}
          />
          <Button
            title="Deny and explain"
            variant="quiet"
            shape="wide"
            className="flex-1"
            disabled={pending}
            onPress={onDenyExplain}
          />
        </View>
      </FloatingBar>
    </View>
  )
}
