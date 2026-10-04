import { View } from "react-native"

import { Mark } from "../components/mark"
import { PageScroller } from "../components/page-scroller"
import { Button } from "../components/ui/button"
import { Icon, type IconName } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import type { Tab } from "../components/tab-bar"
import { cn } from "../lib/cn"

type Unpaired = {
  title: string
  icon: IconName
  headline: string
  body: string
}

const sessions: Unpaired = {
  title: "Sessions",
  icon: "message-square-dashed",
  headline: "No machine is paired",
  body: "Sessions live on the machine that runs them. Until this phone is paired with one there is nothing to list, and nothing is being hidden from you.",
}

// What an unpaired phone cannot show, and why (ruling Q387 A). The design's
// third row named a Review tab the phone does not have; Machine settings
// takes its place.
const unavailable = [
  { label: "Sessions", why: "Nothing to list, and nothing hidden from you." },
  { label: "Machines", why: "This is the screen that owns pairing." },
  { label: "Machine settings", why: "They live on a machine, so they wait until one is paired." },
] as const

export function UnpairedScreen({
  tab,
  bottomInset,
  onPair,
  onScanPairingCode = onPair,
  onTypePairingCode = onPair,
}: {
  tab: Exclude<Tab, "settings">
  bottomInset: number
  onPair: () => void
  onScanPairingCode?: () => void
  onTypePairingCode?: () => void
}) {
  if (tab === "machines") {
    return (
      <View className="flex-1 bg-background">
        <View className="px-4 pb-3 pt-2">
          <Text variant="heading" accessibilityRole="header">Machines</Text>
        </View>
        <PageScroller contentContainerClassName="gap-[14px] px-3" bottomInset={bottomInset}>
          <View className="gap-3 rounded-2xl border border-info-border bg-info-bg p-4">
            <Text className="font-sans-semibold text-[15px] tracking-[-0.01em] text-info-fg">Pair this phone</Text>
            <Text className="text-[13px] leading-[20px] text-info-dim">
              Pairing exchanges keys with one machine directly, over your tailnet. Nothing passes through a server, and the phone stores no code.
            </Text>
            <View className="flex-row gap-2">
              <Button title="Scan a code" variant="info" className="flex-1" onPress={onScanPairingCode} />
              <Button title="Type it" variant="info-outline" className="flex-1" onPress={onTypePairingCode} />
            </View>
          </View>
          <View className="overflow-hidden rounded-2xl border border-border">
            <Text variant="label" className="border-b border-border px-4 py-3">WHAT STAYS UNAVAILABLE</Text>
            {unavailable.map((row, index) => (
              <View
                key={row.label}
                accessible
                accessibilityLabel={`${row.label}. ${row.why}`}
                className={cn("flex-row items-baseline gap-3 px-[15px] py-3", index > 0 && "border-t border-border")}
              >
                <Text className="w-[92px] text-[12.5px] text-strong">{row.label}</Text>
                <Text className="flex-1 text-[12.5px] leading-[19px] text-muted-foreground">{row.why}</Text>
              </View>
            ))}
          </View>
          <Text variant="note" className="px-1 text-faint">
            Device settings still work while unpaired. Machine-scoped settings stay visible and marked unavailable rather than disappearing.
          </Text>
        </PageScroller>
      </View>
    )
  }

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-[11px] px-4 pb-3 pt-2">
        <Mark size={24} />
        <Text variant="heading">{sessions.title}</Text>
      </View>
      <PageScroller
        contentContainerClassName="grow items-center justify-center gap-[11px] px-[26px]"
        bottomInset={bottomInset}
      >
        <View className="h-[52px] w-[52px] items-center justify-center rounded-full bg-accent">
          <Icon name={sessions.icon} tone="muted" size={24} />
        </View>
        <Text className="text-center font-sans-semibold text-[17px] leading-[22px] tracking-[-0.01em] text-foreground">
          {sessions.headline}
        </Text>
        <Text variant="meta" className="text-center leading-[19px]">{sessions.body}</Text>
        <Button title="Pair with a machine" variant="primary" onPress={onPair} className="mt-0.5 px-4 py-3" />
      </PageScroller>
    </View>
  )
}
