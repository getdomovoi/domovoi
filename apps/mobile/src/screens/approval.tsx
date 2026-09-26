import { useState } from "react"
import { Pressable, View } from "react-native"
import type { ApprovalRequest } from "@getdomovoi/protocol"

import type { ConnectionNotice } from "../connection-notice"

import { ConnectionBanner } from "../components/connection-banner"
import { FloatingBar } from "../components/floating-bar"
import { PageScroller } from "../components/page-scroller"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Icon } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import { cn } from "../lib/cn"

// The facts the handoff puts on this screen, in its order. A decision made
// without them is a decision made blind, so none of them are behind a tap.
export function approvalFacts(approval: ApprovalRequest): Array<{ key: string, value: string, tone?: string }> {
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
  notice,
  problem = "",
  onDecide,
  onDenyExplain,
  onBack,
  watching = false,
}: {
  approval: ApprovalRequest
  pending: boolean
  // A watching phone reads the gate in full and answers nothing. The daemon
  // refuses its decisions; the screen does not offer them.
  watching?: boolean
  // The route can die while a gate is open. What is drawn is then the last
  // state the phone was sent, and the screen says so above the decision.
  notice?: ConnectionNotice | undefined
  // A decision that could not be sent. The gate is still waiting on the
  // machine; a client that could not answer it has not changed it.
  problem?: string
  onDecide: (decision: "allow-once" | "always-project" | "deny") => void
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

      <PageScroller
        contentContainerClassName="gap-3 px-3.5"
        bottomInset={footprint}
      >
        <ConnectionBanner notice={notice} />
        <Text variant="body">{approval.operation}</Text>

        <Card className="bg-code px-3.5 py-3.5">
          <Text variant="machine" className="text-[12px] leading-[19px] text-warn-fg">
            {approval.command}
          </Text>
        </Card>

        <Card flush>
          {approvalFacts(approval).map((fact, index) => (
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
      </PageScroller>

      {/* The decision sits in thumb reach at the foot of the screen rather than
          at the end of a scroll, and the affirmative one wears the warning the
          request wears, so neither answer reads as the safe default. */}
      <FloatingBar shape="decision" padding="stack" lifted onFootprint={setFootprint}>
        {watching ? (
          <Text variant="note" className="px-1 text-center">
            Watching only. A device paired with full access answers this gate.
          </Text>
        ) : <>
        {problem ? (
          <Text accessibilityRole="alert" className="px-1 text-[12px] leading-[18px] text-warn-fg">{problem}</Text>
        ) : null}
        <Button
          title="Allow once"
          variant="affirm"
          shape="wide"
          disabled={pending}
          onPress={() => onDecide("allow-once")}
        />
        {/* A rule, not an execution: the gate answered for the fourth time is
            the one a person wants to stop answering. The daemon refuses a
            standing rule on a hard gate, and for a request it could not
            resolve (ruled 2026-09-24), so the button is absent there rather
            than present and refused. */}
        {approval.risk === "hard-gate" || approval.execution.state !== "resolved" ? null : (
          <View className="gap-1">
            <Button
              title="Always allow this"
              variant="outline"
              shape="wide"
              disabled={pending}
              onPress={() => onDecide("always-project")}
            />
            <Text variant="note" className="px-1 text-center">
              Allows it now and stops asking for this command in this project.
            </Text>
          </View>
        )}
        <Button
          title="Deny"
          variant="outline"
          shape="wide"
          disabled={pending}
          onPress={onDenyExplain}
        />
        </>}
      </FloatingBar>
    </View>
  )
}
