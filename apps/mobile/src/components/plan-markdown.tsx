import { Linking, ScrollView, View } from "react-native"

import { parsePlanMarkdown, plainPlanInline, type PlanInlineSpan } from "../lib/plan-markdown"
import { Icon } from "./ui/icon"
import { Text } from "./ui/text"

function Inline({ spans }: { spans: readonly PlanInlineSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        if (span.kind === "code") {
          return <Text key={index} className="rounded bg-accent px-1.5 font-mono text-meta text-foreground">{span.text}</Text>
        }
        if (span.kind === "link") {
          return (
            <Text
              key={index}
              accessibilityRole="link"
              accessibilityLabel={span.text}
              onPress={() => void Linking.openURL(span.url)}
              className="text-primary"
            >
              {span.text}
            </Text>
          )
        }
        return <Text key={index}>{span.text}</Text>
      })}
    </>
  )
}

export function PlanMarkdown({ source }: { source: string }) {
  return (
    <View className="gap-[11px]">
      {parsePlanMarkdown(source).map((block, index) => {
        if (block.kind === "heading") {
          return (
            <Text
              key={index}
              accessibilityRole="header"
              accessibilityLabel={plainPlanInline(block.spans)}
              className={block.level === 1
                ? "font-sans-semibold text-[20px] leading-[26px] tracking-[-0.015em] text-foreground"
                : "mt-1 font-sans-semibold text-[14px] leading-[20px] text-foreground"}
            >
              <Inline spans={block.spans} />
            </Text>
          )
        }
        if (block.kind === "paragraph") {
          return <Text key={index} className="font-sans text-[13.5px] leading-[22px] text-strong"><Inline spans={block.spans} /></Text>
        }
        if (block.kind === "rule") {
          return <View key={index} testID="markdown-rule" className="h-px bg-border" />
        }
        if (block.kind === "code") {
          return (
            <ScrollView key={index} horizontal showsHorizontalScrollIndicator={false} className="rounded-xl bg-code" contentContainerClassName="px-3.5 py-3">
              <Text className="font-mono text-[11.5px] leading-[19px] text-strong">{block.text}</Text>
            </ScrollView>
          )
        }
        if (block.kind === "task") {
          const label = plainPlanInline(block.spans)
          return (
            <View
              key={index}
              accessible
              accessibilityRole="checkbox"
              accessibilityLabel={label}
              accessibilityState={{ checked: block.checked, disabled: true }}
              className="flex-row items-start gap-2.5"
            >
              <View className={block.checked ? "mt-0.5 h-4 w-4 items-center justify-center rounded border border-success bg-success/20" : "mt-0.5 h-4 w-4 rounded border border-border"}>
                {block.checked ? <Icon name="check" tone="success" size={11} /> : null}
              </View>
              <Text className={block.checked ? "flex-1 text-[13px] leading-[20px] text-muted-foreground" : "flex-1 text-[13px] leading-[20px] text-strong"}>
                <Inline spans={block.spans} />
              </Text>
            </View>
          )
        }
        return (
          <View key={index} className="flex-row items-start gap-2.5">
            <Text className="w-5 text-right font-mono text-[12px] leading-[20px] text-faint">{block.ordered ? `${block.marker}.` : "•"}</Text>
            <Text className="flex-1 text-[13px] leading-[20px] text-strong"><Inline spans={block.spans} /></Text>
          </View>
        )
      })}
    </View>
  )
}
