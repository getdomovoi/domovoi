import { useState } from "react"
import { Pressable, ScrollView, TextInput, View } from "react-native"
import type { ApprovalRequest } from "@getdomovoi/protocol"

import { FloatingBar } from "../components/floating-bar"
import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Icon } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import {
  denyReasons,
  explanationProblem,
  reasonChosen,
  withReason,
  withoutReason,
} from "../deny-reasons"
import { cn } from "../lib/cn"
import { colors } from "../theme/tokens.generated"

export function DenyExplainScreen({
  approval,
  pending,
  onSend,
  onBack,
}: {
  approval: ApprovalRequest
  pending: boolean
  onSend: (explanation: string) => void
  onBack: () => void
}) {
  const [explanation, setExplanation] = useState("")
  const [problem, setProblem] = useState("")
  const [footprint, setFootprint] = useState(0)

  const send = () => {
    const refusal = explanationProblem(explanation)
    if (refusal) {
      setProblem(refusal)
      return
    }
    onSend(explanation.trim())
  }

  const write = (next: string) => {
    setExplanation(next)
    if (problem) setProblem("")
  }

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
          <Text variant="nav" numberOfLines={1}>Deny and explain</Text>
          <Text variant="machine">{approval.machine}</Text>
        </View>
        <View className="self-start rounded-full border border-danger-border px-[7px] py-[3px]">
          <Text className="font-mono text-[9.5px] uppercase tracking-[0.06em] text-danger-fg">
            Denying
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerClassName="gap-3 px-3.5"
        contentContainerStyle={{ paddingBottom: footprint }}
      >
        {/* Struck through, because the point of this screen is that nothing
            ran and nothing is going to. */}
        <Card className="bg-code px-[13px] py-[11px]">
          <Text
            variant="machine"
            className="text-[11.5px] leading-[17px] text-danger-fg line-through"
          >
            {approval.command}
          </Text>
          <Text variant="note" className="mt-1.5 text-faint">
            Will not run. The daemon holds the turn until this reply lands.
          </Text>
        </Card>

        <Card className="border-primary/35">
          <Text variant="label">Reason sent to the agent</Text>
          <TextInput
            multiline
            editable={!pending}
            value={explanation}
            onChangeText={write}
            placeholder="Why this is not running, and what to do instead."
            placeholderTextColor={colors.dark.faint}
            selectionColor={colors.dark.primary}
            accessibilityLabel="Reason sent to the agent"
            className="mt-[7px] max-h-40 min-h-tap font-sans text-[12.5px] leading-[20px] text-foreground"
          />
        </Card>

        {problem ? <Text className="text-[11px] text-destructive">{problem}</Text> : null}

        <View className="flex-row flex-wrap gap-1.5">
          {denyReasons.map((reason) => {
            const chosen = reasonChosen(explanation, reason)
            return (
              <Pressable
                key={reason}
                accessibilityRole="button"
                accessibilityState={{ selected: chosen }}
                accessibilityLabel={reason}
                onPress={() => write(chosen
                  ? withoutReason(explanation, reason)
                  : withReason(explanation, reason))}
                className={cn(
                  "rounded-full border px-3 py-[7px] active:opacity-70",
                  chosen ? "border-primary/45 bg-primary/15" : "border-border",
                )}
              >
                <Text className={cn(
                  "text-[11.5px]",
                  chosen ? "text-primary" : "text-muted-foreground",
                )}>
                  {reason}
                </Text>
              </Pressable>
            )
          })}
        </View>

        <Card className="flex-row items-start gap-2.5">
          <Icon name="ban" tone="faint" size={24} />
          <Text variant="meta" className="flex-1 leading-[19px]">
            The agent keeps the thread, the plan and the worktree. It gets the denial and this
            text, nothing else.
          </Text>
        </Card>
      </ScrollView>

      <FloatingBar shape="decision" padding="stack" lifted onFootprint={setFootprint}>
        <Button
          title="Send denial"
          variant="deny"
          shape="wide"
          disabled={pending}
          onPress={send}
        />
        <Button
          title="Back to the decision"
          variant="quiet"
          shape="wide"
          disabled={pending}
          onPress={onBack}
        />
      </FloatingBar>
    </View>
  )
}
