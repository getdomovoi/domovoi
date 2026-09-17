import { Pressable, ScrollView, View } from "react-native"
import type { WorkspaceSnapshot } from "@getdomovoi/protocol"
import { WebView } from "react-native-webview"

import { PageScroller } from "../components/page-scroller"
import { Badge } from "../components/ui/badge"
import { Card } from "../components/ui/card"
import { Icon } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import { artifactBody, diffLines, type DiffLine } from "../artifact-rows"
import { cn } from "../lib/cn"
import { openAnnotationCount, type AnnotationRow } from "../review-rows"

// What the phone knows about fetching a preview's render. The bytes never
// land here: a signed grant from the daemon becomes an address the frame
// loads from the machine, and the grant is what can fail.
export type PreviewRender =
  | { state: "pending" }
  | { state: "ready", url: string }
  | { state: "failed", reason: string }

export type PreviewVariant = { id: string, label: string }

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
            "font-mono text-machine",
            open ? "text-primary-foreground" : "text-muted-foreground",
          )}>
            {row.pin}
          </Text>
        </View>
        <Text variant="machine" className="flex-1" numberOfLines={1}>{row.anchor}</Text>
        <Badge label={row.status} tone={open ? "attention" : "neutral"} />
      </View>
      <Text className="mt-[7px] text-[12px] leading-[18px] text-strong">{row.body}</Text>
      <Text variant="machine" className="mt-2 text-faint">{row.meta}</Text>
    </Card>
  )
}

function Render({ render }: { render: PreviewRender }) {
  if (render.state === "pending") {
    return (
      <Card className="border-info-border bg-info-bg">
        <Text className="text-[11.5px] leading-[18px] text-info-fg">Fetching the render from the machine.</Text>
      </Card>
    )
  }
  if (render.state === "failed") {
    return (
      <Card className="border-destructive/40 bg-card">
        <Text className="text-[11.5px] leading-[18px] text-strong">The render could not be fetched.</Text>
        <Text variant="machine" className="mt-2 text-faint">{render.reason}</Text>
      </Card>
    )
  }
  return (
    <View className="gap-2">
      <View className="h-[420px] overflow-hidden rounded-xl border border-border bg-code">
        <WebView
          testID="preview-render"
          source={{ uri: render.url }}
          // The grant is for this address alone. A link out of the render is
          // a navigation the daemon never signed, so the frame stays put.
          onShouldStartLoadWithRequest={(request) => request.url === render.url}
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures={false}
        />
      </View>
      <Text variant="note">
        The render stays on the machine. This phone displays it and never downloads the repository.
      </Text>
    </View>
  )
}

export function ArtifactScreen({
  artifact,
  comments,
  render,
  variants,
  onBack,
  onOpenVariant,
}: {
  artifact: WorkspaceSnapshot["artifacts"][number]
  comments: AnnotationRow[]
  // Present only for a preview: what became of the fetch for its render.
  render: PreviewRender | undefined
  // The other renders in this one's variant group, this one included, in the
  // order the person named them. Empty when the render stands alone.
  variants: PreviewVariant[]
  onBack: () => void
  onOpenVariant: (artifactId: string) => void
}) {
  const body = artifactBody(artifact)
  const open = openAnnotationCount(comments)
  const rendered = artifact.type === "preview" && render !== undefined
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
        {variants.length > 1 ? (
          <View className="flex-row gap-1.5">
            {variants.map((variant) => {
              const selected = variant.id === artifact.id
              return (
                <Pressable
                  key={variant.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Variant ${variant.label}`}
                  accessibilityState={{ selected }}
                  onPress={() => { if (!selected) onOpenVariant(variant.id) }}
                  className={cn(
                    "min-h-tap flex-1 items-center justify-center rounded-lg border",
                    selected ? "border-primary bg-primary/15" : "border-border bg-card",
                  )}
                >
                  <Text className={cn("font-sans-medium text-[12.5px]", selected ? "text-primary" : "text-muted-foreground")}>
                    {variant.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        ) : null}

        {rendered ? <Render render={render} /> : null}

        {!body.readable && !rendered ? (
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
            <Text variant="label" className="tracking-[0.12em]">Comments</Text>
            <View className="h-px flex-1 bg-border" />
            <Text variant="machine" className="text-faint">{open} open</Text>
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
