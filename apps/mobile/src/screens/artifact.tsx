import { ScrollView, View } from "react-native"
import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Text } from "../components/ui/text"
import { artifactBody, diffLines, type DiffLine } from "../artifact-rows"
import { cn } from "../lib/cn"

const diffTone: Record<DiffLine["tone"], string> = {
  added: "text-success",
  removed: "text-destructive",
  meta: "text-primary",
  context: "text-muted-foreground",
}

export function ArtifactScreen({
  artifact,
  onBack,
}: {
  artifact: WorkspaceSnapshot["artifacts"][number]
  onBack: () => void
}) {
  const body = artifactBody(artifact)
  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-2 px-2 py-3">
        <Button title="‹" variant="ghost" onPress={onBack} className="px-3" accessibilityLabel="Back to the session" />
        <View className="flex-1 gap-0.5">
          <Text variant="title" numberOfLines={1}>{artifact.title}</Text>
          <Text variant="machine">
            {artifact.type} · revision {artifact.revision}
          </Text>
        </View>
        {artifact.variant ? (
          <View className="pr-2"><Badge label={artifact.variant.label} /></View>
        ) : null}
      </View>

      <ScrollView contentContainerClassName="gap-3 px-3.5 pb-8">
        {!body.readable ? (
          <Card className="gap-2 border-info-border bg-info-bg">
            <Text className="text-[12px] leading-5 text-info-fg">{body.reason}</Text>
            {artifact.path
              ? <Text variant="machine" className="text-[10px] text-info-fg">{artifact.path}</Text>
              : null}
          </Card>
        ) : null}

        {body.readable && artifact.type === "diff" ? (
          <ScrollView horizontal contentContainerClassName="min-w-full">
            <View className="rounded-2xl border border-border bg-code p-3">
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
          <View className="rounded-2xl border border-border bg-code p-3">
            {body.lines.map((line, index) => (
              <Text key={`${index}-${line}`} className="font-mono text-[10.5px] leading-4 text-foreground">
                {line === "" ? " " : line}
              </Text>
            ))}
          </View>
        ) : null}

        {body.readable && body.omitted > 0 ? (
          <Text variant="meta" className="text-center">
            {body.omitted} more line{body.omitted === 1 ? "" : "s"} are not shown on this phone.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  )
}
