import { useState } from "react"
import { Pressable, View } from "react-native"
import type { ToolInventory } from "@getdomovoi/protocol"

import { BlurBackdrop } from "../components/blur-backdrop"
import { ConnectionBanner } from "../components/connection-banner"
import { FloatingBar } from "../components/floating-bar"
import { PageScroller } from "../components/page-scroller"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Icon } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import type { ConnectionNotice } from "../connection-notice"
import { heldBackView, type HeldBackFile, type UnreadFile } from "../held-back"

export type ToolsLoad =
  | { state: "loading" }
  | { state: "error", message: string }
  | { state: "loaded", inventory: ToolInventory }

// Skills design step 18: what the open repository holds back, every entry
// grouped by the file that declared it, and a bar saying trust is granted
// from desktop or web. The phone reads and reports. It has no trust control,
// and its credential cannot call the trust methods (ruling Q67).
export function ToolsScreen({
  load,
  machine,
  notice,
  connected,
  onBack,
  onRefresh,
}: {
  load: ToolsLoad
  machine: string
  notice: ConnectionNotice | undefined
  connected: boolean
  onBack: () => void
  onRefresh: () => void
}) {
  const [footprint, setFootprint] = useState(0)
  const view = load.state === "loaded" ? heldBackView(load.inventory) : undefined
  // Trusting on desktop or web lifts the hold only where trust is still to
  // do. A trusted repository, or one that cannot be trusted, is not pointed
  // there, and neither is a screen still reading or one whose read failed:
  // no trust state is known, and trust would not fix a failed read.
  const pointsToTrust = view?.kind === "repository" && view.awaitsTrust

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
          <Text variant="nav" numberOfLines={1}>Tools</Text>
          <Text variant="machine" numberOfLines={1}>{machine}</Text>
        </View>
        <Badge label="Read only" tone="outline" pill />
        <Button title="Refresh" onPress={onRefresh} disabled={load.state === "loading" || !connected} />
      </View>

      {/* What the footer card blurs on Android. The card stays outside it. */}
      <BlurBackdrop style={{ flex: 1 }}>
        <PageScroller contentContainerClassName="gap-3 px-3.5" bottomInset={footprint}>
          <ConnectionBanner notice={notice} />

          {load.state === "loading" ? (
            <Text variant="meta">Reading the agents' files on {machine}.</Text>
          ) : null}

          {load.state === "error" ? (
            <Card className="gap-2 border-destructive">
              <Text className="font-sans-medium text-[13px] text-destructive">Tools could not be read</Text>
              <Text variant="meta">{load.message}</Text>
              <Button title="Try again" className="self-start" onPress={onRefresh} disabled={!connected} />
            </Card>
          ) : null}

          {view?.kind === "no-project" ? (
            <Card className="gap-1.5">
              <Text variant="section">No project is open</Text>
              <Text variant="meta">Open a project, and Domovoi reads the files its agents would load there.</Text>
            </Card>
          ) : null}

          {view?.kind === "repository" ? (
            <>
              <Card className="gap-1.5">
                <Text variant="section">{view.heading}</Text>
                <Text variant="meta">{view.lead}</Text>
                {view.instructionFiles ? (
                  <View className="flex-row flex-wrap items-baseline gap-x-1.5">
                    <Text variant="meta">Instruction files load either way:</Text>
                    <Text variant="machine" className="text-strong">{view.instructionFiles}</Text>
                  </View>
                ) : null}
                <Text variant="machine">{view.root} · {view.trust}</Text>
              </Card>

              {view.refusals.length > 0 ? (
                <Card flush className="border-warn-border">
                  <View className="gap-1 px-[13px] py-3">
                    <Text className="font-sans-medium text-[13px] text-warn-fg">{view.name} cannot be trusted on this machine</Text>
                    <Text variant="meta">Its agents would also load what is listed here, and trust cannot cover it.</Text>
                  </View>
                  {view.refusals.map((refusal) => (
                    <View key={refusal.key} className="gap-0.5 border-t border-border px-[13px] py-2.5">
                      <Text variant="machine" className="text-strong">{refusal.provider}</Text>
                      <Text variant="meta">{refusal.label}</Text>
                      <Text variant="machine" className="text-faint">{refusal.path}</Text>
                    </View>
                  ))}
                  {view.omittedRefusals > 0 ? (
                    <Text variant="meta" className="border-t border-border px-[13px] py-2.5">
                      {view.omittedRefusals} more {view.omittedRefusals === 1 ? "reason is" : "reasons are"} not listed.
                    </Text>
                  ) : null}
                </Card>
              ) : null}

              {view.files.map((file) => <FileCard key={file.path} file={file} reason={view.reason} />)}

              {view.unread.map((file) => <UnreadCard key={`${file.provider}:${file.path}`} file={file} />)}

              {view.incomplete ? (
                <Text variant="meta">This list is not complete: {view.incomplete}.</Text>
              ) : null}
            </>
          ) : null}
        </PageScroller>
      </BlurBackdrop>

      <FloatingBar shape="card" padding="stack" onFootprint={setFootprint}>
        <View className="gap-0.5 px-1.5 py-1">
          {pointsToTrust ? (
            <Text className="font-sans-medium text-[13px] text-foreground">Trust from desktop or web</Text>
          ) : null}
          <Text variant="note">A phone shows this but cannot trust it.</Text>
        </View>
      </FloatingBar>
    </View>
  )
}

// One file's held-back entries. The facts stack rather than sit in columns,
// and each keeps its full text: a phone collapses, it does not cut.
function FileCard({ file, reason }: { file: HeldBackFile, reason: string }) {
  return (
    <Card flush accessibilityLabel={file.path}>
      <View className="gap-1 px-[13px] py-3">
        <Text variant="machine" className="text-[12px] text-foreground">{file.path}</Text>
        <Text variant="note">{file.source} · {file.providers.join(" · ")} · {file.counts}</Text>
        <Text variant="note" className="text-strong">{reason}</Text>
      </View>
      {file.rows.map((row) => (
        <View key={row.key} className="gap-0.5 border-t border-border px-[13px] py-2.5">
          <View className="flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
            <Text variant="label">{row.kind}</Text>
            <Text variant="machine" className="text-faint">{row.provider}</Text>
          </View>
          <Text variant="machine" className="text-[11.5px] text-strong">{row.name}</Text>
          {row.detail ? <Text variant="machine" className="text-faint">{row.detail}</Text> : null}
        </View>
      ))}
    </Card>
  )
}

function UnreadCard({ file }: { file: UnreadFile }) {
  return (
    <Card className="gap-1 border-danger-border">
      <Text className="text-[12.5px] text-danger-fg">Could not read</Text>
      <Text variant="machine" className="text-danger-fg">{file.path}</Text>
      <Text variant="machine" className="text-faint">{file.reason}</Text>
      <Text variant="note">{file.source} · {file.provider}. Its entries are not listed. Domovoi does not guess what the file holds.</Text>
    </Card>
  )
}
