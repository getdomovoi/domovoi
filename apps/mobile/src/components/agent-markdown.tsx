import { ScrollView, View } from "react-native"

import { parseAgentMarkdown, type InlineSpan } from "../lib/agent-markdown"
import { Text } from "./ui/text"

// An agent's reply is the one place a phone has to show a command exactly. It
// used to render as one plain run, so fences and backticks appeared as
// characters and the command lost its monospace face.

function Inline({ spans }: { spans: InlineSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        if (span.kind === "code") {
          return (
            <Text key={index} className="font-mono text-meta text-foreground">{span.text}</Text>
          )
        }
        if (span.kind === "strong") {
          return <Text key={index} className="font-sans-medium text-body text-foreground">{span.text}</Text>
        }
        return <Text key={index}>{span.text}</Text>
      })}
    </>
  )
}

export function AgentMarkdown({ body, className }: { body: string; className?: string }) {
  const blocks = parseAgentMarkdown(body)
  return (
    <View className={className}>
      {blocks.map((block, index) => {
        if (block.kind === "code") {
          return (
            // A command must not wrap: a broken line is a different command.
            // It scrolls sideways instead, which keeps it copyable.
            <ScrollView
              key={index}
              horizontal
              showsHorizontalScrollIndicator={false}
              className="mt-2 rounded-lg border border-border bg-code"
              contentContainerClassName="px-3 py-2.5"
            >
              <Text className="font-mono text-meta text-foreground">{block.text}</Text>
            </ScrollView>
          )
        }
        if (block.kind === "bullet") {
          return (
            <View key={index} className="mt-1 flex-row gap-2">
              <Text variant="body" className="text-faint">•</Text>
              <Text variant="body" className="flex-1 leading-[20px]"><Inline spans={block.spans} /></Text>
            </View>
          )
        }
        return (
          <Text key={index} variant="body" className={index === 0 ? "leading-[20px]" : "mt-2 leading-[20px]"}>
            <Inline spans={block.spans} />
          </Text>
        )
      })}
    </View>
  )
}
