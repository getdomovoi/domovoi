import { ScrollView, View } from "react-native"

import { ConnectionBanner } from "../components/connection-banner"
import { Badge } from "../components/ui/badge"
import { Card, PressableCard } from "../components/ui/card"
import { Icon } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import type { ConnectionNotice } from "../connection-notice"
import { reviewSummary, type ReviewRow } from "../review-rows"

function ReviewCard({ row, onOpen }: { row: ReviewRow, onOpen: (artifactId: string) => void }) {
  return (
    <PressableCard
      accessibilityLabel={`Open ${row.title}`}
      onPress={() => onOpen(row.id)}
    >
      <View className="flex-row items-start gap-2.5">
        <View className="flex-1">
          <View className="flex-row items-center gap-1.5">
            <Text variant="title" className="flex-1" numberOfLines={2}>{row.title}</Text>
            {row.variantLabel ? <Badge label={row.variantLabel} tone="outline" /> : null}
          </View>
          <Text variant="machine" className="mt-[5px] text-[9.5px] text-faint">{row.detail}</Text>
        </View>
        <Icon name="chevron-right" tone="faint" size={16} />
      </View>

      <View className="mt-2 flex-row items-center gap-2">
        <Text variant="note" className="flex-1" numberOfLines={1}>{row.sessionTitle}</Text>
        {row.open > 0 ? <Badge label={`${row.open} open`} tone="attention" /> : null}
        {row.resolved > 0 ? <Badge label={`${row.resolved} resolved`} tone="outline" /> : null}
      </View>
    </PressableCard>
  )
}

export function ReviewScreen({
  rows,
  notice,
  hasSnapshot,
  onOpenArtifact,
  bottomInset,
}: {
  rows: ReviewRow[]
  notice: ConnectionNotice | undefined
  // The daemon has said what this workspace holds. Until it has, an empty list
  // is a phone that has not been told rather than a workspace with nothing in
  // it, and the two read the same on screen unless the screen says which.
  hasSnapshot: boolean
  onOpenArtifact: (artifactId: string) => void
  // What the floating tab bar covers, so the list can pad by exactly that.
  bottomInset: number
}) {
  return (
    <View className="flex-1 bg-background">
      <View className="px-4 pb-3 pt-2">
        <Text variant="heading">Review</Text>
        {hasSnapshot ? <Text variant="meta" className="mt-[3px]">{reviewSummary(rows)}</Text> : null}
      </View>

      <ScrollView
        contentContainerClassName="gap-[9px] px-3"
        contentContainerStyle={{ paddingBottom: bottomInset }}
      >
        <ConnectionBanner notice={notice} />

        {!hasSnapshot ? (
          <Text variant="meta">Nothing has been received from this daemon yet.</Text>
        ) : null}

        {hasSnapshot && rows.length === 0 ? (
          <Card className="border-dashed">
            <Text variant="meta">
              Nothing has been rendered for review on this machine yet. A plan, preview or diff
              opens here as soon as an agent produces one.
            </Text>
          </Card>
        ) : null}

        {rows.map((row) => <ReviewCard key={row.id} row={row} onOpen={onOpenArtifact} />)}
      </ScrollView>
    </View>
  )
}
