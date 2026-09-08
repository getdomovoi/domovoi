import { Pressable, ScrollView, View } from "react-native"
import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import { PageScroller } from "../components/page-scroller"
import { Badge } from "../components/ui/badge"
import { Card } from "../components/ui/card"
import { Icon } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import { artifactBody, diffLines, type DiffLine } from "../artifact-rows"
import { cn } from "../lib/cn"
import { openAnnotationCount, type AnnotationRow } from "../review-rows"

const diffTone: Record<DiffLine["tone"], string> = {
  added: "text-success",
  removed: "text-destructive",
  meta: "text-primary",
  context: "text-muted-foreground",
}

// The handoff pins a comment to the place it was made and repeats the pin on
// the card, so a number read on the preview is the number read in the list.
function Comment({ row }: { row: AnnotationRow }) {
  const open = row.status === "open"
  return (
    <Card className={cn("px-3 py-[11px]", open && "border-primary/40")}>
      <View className="flex-row items-center gap-2">
        <View className={cn(
          "h-4 w-4 items-center justify-center rounded-full",
          open ? "bg-primary" : "bg-muted",
        )}>
          <Text className={cn(
            "font-mono text-[9px]",
            open ? "text-primary-foreground" : "text-muted-foreground",
          )}>
            {row.pin}
          </Text>
        </View>
        <Text variant="machine" className="flex-1 text-[9.5px]" numberOfLines={1}>{row.anchor}</Text>
        <Badge label={row.status} tone={open ? "attention" : "neutral"} />
      </View>
      <Text className="mt-[7px] text-[12px] leading-[18px] text-strong">{row.body}</Text>
      <Text variant="machine" className="mt-2 text-[9px] text-faint">{row.meta}</Text>
    </Card>
  )
}

export function ArtifactScreen({
  artifact,
  comments,
  onBack,
}: {
  artifact: WorkspaceSnapshot["artifacts"][number]
  comments: AnnotationRow[]
  onBack: () => void
}) {
  const body = artifactBody(artifact)
  const open = openAnnotationCount(comments)
  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2.5 px-3.5 pb-2.5 pt-1.5">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to the session"
          onPress={onBack}
          className="min-h-tap min-w-tap -ml-3 items-center justify-center active:opacity-70"
        >
          <Icon name="chevron-left" tone="primary" />
        </Pressable>
        <View className="flex-1">
          <Text variant="nav" numberOfLines={1}>{artifact.title}</Text>
          <Text variant="machine">
            {artifact.type} · revision {artifact.revision}
          </Text>
        </View>
        {artifact.variant ? <Badge label={artifact.variant.label} tone="outline" /> : null}
      </View>

      <PageScroller contentContainerClassName="gap-3 px-3.5 pb-8">
        {!body.readable ? (
          <Card className="border-info-border bg-info-bg">
            <Text className="text-[11.5px] leading-[18px] text-info-fg">{body.reason}</Text>
            {artifact.path
              ? <Text variant="machine" className="mt-2 text-info-fg">{artifact.path}</Text>
              : null}
          </Card>
        ) : null}

        {body.readable && artifact.type === "diff" ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="min-w-full"
          >
            <View className="rounded-xl border border-border bg-code p-3">
              {diffLines(body.lines).map((line, index) => (
                <Text
                  key={`${index}-${line.text}`}
                  className={cn("font-mono text-[10px] leading-4", diffTone[line.tone])}
                >
                  {line.text === "" ? " " : line.text}
                </Text>
              ))}
            </View>
          </ScrollView>
        ) : null}

        {body.readable && artifact.type !== "diff" ? (
          <View className="rounded-xl border border-border bg-code p-3">
            {body.lines.map((line, index) => (
              <Text key={`${index}-${line}`} className="font-mono text-[10.5px] leading-4 text-foreground">
                {line === "" ? " " : line}
              </Text>
            ))}
          </View>
        ) : null}

        {body.readable && body.omitted > 0 ? (
          <Text variant="note" className="text-center">
            {body.omitted} more line{body.omitted === 1 ? "" : "s"} are not shown on this phone.
          </Text>
        ) : null}

        {comments.length > 0 ? (
          <View className="mt-1 flex-row items-center gap-2">
            <Text variant="label" className="text-[9.5px] tracking-[0.12em]">Comments</Text>
            <View className="h-px flex-1 bg-border" />
            <Text variant="machine" className="text-[9.5px] text-faint">{open} open</Text>
          </View>
        ) : null}

        {comments.map((row) => <Comment key={row.id} row={row} />)}

        {/* Anchoring a new comment means picking an element in a rendered
            preview, which is the desktop's job until this phone can fetch one. */}
        {comments.length === 0 ? (
          <Text variant="note" className="text-center">
            No comments on this artifact. Anchoring one to the preview is done from the desktop.
          </Text>
        ) : null}
      </PageScroller>
    </View>
  )
}
