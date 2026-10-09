import { useState } from "react"
import { Pressable, View } from "react-native"
import type { ApprovalRequest, WorkingPlan } from "@getdomovoi/protocol"

import type { ConnectionNotice } from "../connection-notice"
import { approvalContextFacts, type ApprovalViewer } from "../lib/approval-context"

import { BlurBackdrop } from "../components/blur-backdrop"
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

// The phone's list: the request's own facts with the context the wire carries
// beside them. Who started the turn and the plan step it blocks sit with the
// agent and mode; whether it reaches outside the project sits with the
// directory it was judged against. A context fact the daemon did not send is
// not drawn, because absent means it could not decide.
export function phoneApprovalFacts(
  approval: ApprovalRequest,
  context: { plans?: readonly WorkingPlan[] | undefined, viewer?: ApprovalViewer | undefined },
): Array<{ key: string, value: string, tone?: string }> {
  const { origin, step, outsideProject } = approvalContextFacts(approval, context)
  return approvalFacts(approval).flatMap((fact) => {
    if (fact.key === "Mode") return [fact, ...(origin ? [origin] : []), ...(step ? [step] : [])]
    if (fact.key === "Directory") return [fact, ...(outsideProject ? [outsideProject] : [])]
    return [fact]
  })
}

export function ApprovalScreen({
  approval,
  sessionTitle,
  plans,
  viewer,
  pending,
  notice,
  problem = "",
  onDecide,
  onDenyExplain,
  onBack,
  watching = false,
}: {
  approval: ApprovalRequest
  // The session the gate belongs to, named above it so the person knows
  // which piece of work is asking. The machine stands in when the phone has
  // no session by that id.
  sessionTitle?: string | undefined
  // The session plans the phone holds, read for the step this gate blocks.
  plans?: readonly WorkingPlan[] | undefined
  // This phone, compared with the client that started the turn.
  viewer?: ApprovalViewer | undefined
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
        <Text className="flex-1 font-sans text-[13px] text-muted-foreground" numberOfLines={1}>
          {sessionTitle ?? approval.machine}
        </Text>
        {approval.risk === "hard-gate" ? <Badge label="Hard gate" tone="warning" pill /> : null}
      </View>

      {/* What the decision bar blurs on Android. The bar stays outside it. */}
      <BlurBackdrop style={{ flex: 1 }}>
        <PageScroller
          contentContainerClassName="gap-[13px] px-4"
          bottomInset={footprint}
        >
          <ConnectionBanner notice={notice} />
          {/* Whose turn it is, in the gate's own amber. A watching phone
              cannot answer, so for it the gate waits on someone else. */}
          <View className="flex-row items-center gap-[11px]">
            <View className="h-[11px] w-[11px] rounded-full bg-warning" />
            <Text
              accessibilityRole="header"
              className="flex-1 font-sans-semibold text-[24px] leading-[30px] tracking-[-0.02em] text-warn-fg"
            >
              {watching ? "Waiting on a full-access device" : "Waiting on you"}
            </Text>
          </View>
          {/* A gate is raised before its command runs, so a pending one has
              changed nothing yet. */}
          <View>
            <Text className="font-sans text-[14px] leading-[22px] text-strong">{approval.operation}</Text>
            <Text className="font-sans text-[14px] leading-[22px] text-strong">Nothing has run yet.</Text>
          </View>

          <View className="rounded-2xl bg-code px-[15px] py-3.5">
            <Text className="font-mono text-[14px] leading-[21px] text-warn-fg">
              {approval.command}
            </Text>
          </View>

          <Card flush>
            {phoneApprovalFacts(approval, { plans, viewer }).map((fact, index) => (
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
      </BlurBackdrop>

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
