import { View } from "react-native"

import { PageScroller } from "../components/page-scroller"
import { Button } from "../components/ui/button"
import { Icon, type IconName } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import type { Tab } from "../components/tab-bar"

type Unpaired = {
  title: string
  icon: IconName
  headline: string
  body: string
  footer: string
}

const sessions: Unpaired = {
  title: "Sessions",
  icon: "layers",
  headline: "No machine is paired",
  body: "Sessions live on the machine that runs them. Until this phone is paired with one there is nothing to list, and nothing is being hidden from you.",
  footer: "The phone is a client. It never runs an agent itself.",
}

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
          <Text variant="heading">Machines</Text>
        </View>
        <PageScroller contentContainerClassName="gap-[14px] px-3" bottomInset={bottomInset}>
          <View className="gap-3 rounded-2xl border border-info-border bg-info-bg p-4">
            <Text className="font-sans-medium text-[15px] text-info-fg">Pair this phone</Text>
            <Text className="text-[13px] leading-[20px] text-info-dim">
              Pairing exchanges keys with one machine directly, over your tailnet. Nothing passes through a server, and the phone stores no code.
            </Text>
            <View className="flex-row gap-2">
              <Button title="Scan a code" variant="primary" className="flex-1" onPress={onScanPairingCode} />
              <Button title="Type it" variant="outline" className="flex-1" onPress={onTypePairingCode} />
            </View>
          </View>
          <View className="overflow-hidden rounded-2xl border border-border">
            <Text variant="label" className="border-b border-border px-4 py-3">WHAT STAYS UNAVAILABLE</Text>
            <Text className="px-4 py-3 text-[12.5px] text-strong">Sessions</Text>
            <Text className="border-t border-border px-4 py-3 text-[12.5px] text-strong">Machine settings</Text>
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
      <View className="px-4 pb-3 pt-2">
        <Text variant="heading">{sessions.title}</Text>
      </View>
      <PageScroller
        contentContainerClassName="grow items-center justify-center gap-[11px] px-[26px]"
        bottomInset={bottomInset}
      >
        <Icon name={sessions.icon} tone="faint" size={24} />
        <Text className="text-center font-sans-medium text-[14.5px] text-foreground">
          {sessions.headline}
        </Text>
        <Text variant="meta" className="text-center leading-[19px]">{sessions.body}</Text>
        <Button title="Pair with a machine" variant="primary" onPress={onPair} className="mt-0.5 px-4 py-3" />
        <Text variant="note" className="text-center text-faint">{sessions.footer}</Text>
      </PageScroller>
    </View>
  )
}
