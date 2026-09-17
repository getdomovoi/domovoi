import { useEffect, useRef, useState } from "react"
import { Pressable, ScrollView, TextInput, View } from "react-native"
import type { WorkspaceSnapshot } from "@getdomovoi/protocol"
import { WebView } from "react-native-webview"

import { PageScroller } from "../components/page-scroller"
import { Badge } from "../components/ui/badge"
import { Card } from "../components/ui/card"
import { Button } from "../components/ui/button"
import { Icon } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import { artifactBody, diffLines, type DiffLine } from "../artifact-rows"
import { cn } from "../lib/cn"
import { pickerScript, readSelection, webviewBridgeScript, type PreviewSelection } from "../preview-bridge"
import { openAnnotationCount, type AnnotationRow } from "../review-rows"
import { colors } from "../theme/tokens.generated"

// What the phone knows about fetching a preview's render. The bytes never
// land here: a signed grant from the daemon becomes an address the frame
// loads from the machine, and the grant is what can fail.
export type PreviewRender =
  | { state: "pending" }
  // The channel is the match key the bridge script in the render answers on.
  | { state: "ready", url: string, channel: string }
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

function Render({ render, artifactId, picking, onSelect }: {
  render: PreviewRender
  artifactId: string
  // While picking, the bridge in the render highlights what is under the
  // finger and reports the element tapped instead of letting the tap through.
  picking: boolean
  onSelect: (selection: PreviewSelection) => void
}) {
  const frame = useRef<WebView>(null)
  useEffect(() => {
    if (render.state !== "ready") return
    frame.current?.injectJavaScript(pickerScript(render.channel, picking))
  }, [picking, render])
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
      <View className={cn("h-[420px] overflow-hidden rounded-xl border bg-code", picking ? "border-primary" : "border-border")}>
        <WebView
          ref={frame}
          testID="preview-render"
          source={{ uri: render.url }}
          // The grant is for this address alone. A link out of the render is
          // a navigation the daemon never signed, so the frame stays put.
          onShouldStartLoadWithRequest={(request) => request.url === render.url}
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures={false}
          injectedJavaScript={webviewBridgeScript(render.channel)}
          onMessage={(event) => {
            const selection = readSelection(event.nativeEvent.data, render.channel, artifactId)
            if (selection) onSelect(selection)
          }}
        />
      </View>
      <Text variant="note">
        The render stays on the machine. This phone displays it and never downloads the repository.
      </Text>
    </View>
  )
}

// Frame 18. The comment travels as a reference to the element, coordinates
// plus text, never as a flattened screenshot; a re-render says whether it
// still points anywhere.
function CommentComposer({ selection, sending, onSend, onCancel }: {
  selection: PreviewSelection
  sending: boolean
  onSend: (body: string) => void
  onCancel: () => void
}) {
  const [body, setBody] = useState("")
  const usable = body.trim().length > 0
  return (
    <Card className="gap-2.5">
      <View>
        <Text variant="label" className="tracking-[0.12em]">ANCHORED TO</Text>
        <Text className="mt-1 text-[12.5px] text-strong">{selection.label}</Text>
      </View>
      <TextInput
        multiline
        autoFocus
        editable={!sending}
        value={body}
        onChangeText={setBody}
        placeholder="What should change here?"
        placeholderTextColor={colors.dark.faint}
        selectionColor={colors.dark.primary}
        accessibilityLabel="Comment on this element"
        className="min-h-[72px] rounded-lg border border-border bg-code px-2.5 py-2 font-sans text-[12px] text-foreground"
      />
      <Text variant="note">
        Sent as a reference to that element, so a re-render tells you if it no longer points anywhere.
      </Text>
      <View className="flex-row justify-end gap-2">
        <Button title="Cancel" onPress={onCancel} disabled={sending} />
        <Button title="Send to the agent" variant="primary" onPress={() => { if (usable) onSend(body.trim()) }} disabled={sending || !usable} />
      </View>
    </Card>
  )
}

export function ArtifactScreen({
  artifact,
  comments,
  render,
  variants,
  onBack,
  onOpenVariant,
  onComment,
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
  onComment: (anchor: PreviewSelection["anchor"], body: string) => Promise<void>
}) {
  const body = artifactBody(artifact)
  const open = openAnnotationCount(comments)
  const rendered = artifact.type === "preview" && render !== undefined
  const [picking, setPicking] = useState(false)
  const [selection, setSelection] = useState<PreviewSelection | undefined>(undefined)
  const [sending, setSending] = useState(false)
  const send = async (text: string) => {
    if (!selection) return
    setSending(true)
    try {
      await onComment(selection.anchor, text)
      setSelection(undefined)
    } finally {
      setSending(false)
    }
  }
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

        {rendered ? (
          <Render
            render={render}
            artifactId={artifact.id}
            picking={picking}
            onSelect={(picked) => { setPicking(false); setSelection(picked) }}
          />
        ) : null}

        {rendered && render.state === "ready" && !selection ? (
          <View className="gap-2">
            {picking ? (
              <Text variant="note" className="text-primary">Tap the element in the render you want to comment on.</Text>
            ) : null}
            <View className="flex-row">
              <Button title={picking ? "Stop picking" : "Comment"} onPress={() => setPicking(!picking)} />
            </View>
          </View>
        ) : null}

        {selection ? (
          <CommentComposer
            selection={selection}
            sending={sending}
            onSend={(text) => void send(text)}
            onCancel={() => setSelection(undefined)}
          />
        ) : null}

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

        {/* A comment is anchored to an element in a rendered preview. Where
            there is no render on this screen there is nothing to anchor to. */}
        {comments.length === 0 ? (
          <Text variant="note" className="text-center">
            {rendered && render.state === "ready"
              ? "No comments on this render yet."
              : "No comments on this artifact. Anchoring one means picking an element in a rendered preview."}
          </Text>
        ) : null}
      </PageScroller>
    </View>
  )
}
