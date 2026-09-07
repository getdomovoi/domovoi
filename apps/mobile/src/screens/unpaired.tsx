import { ScrollView, View } from "react-native"

import { Button } from "../components/ui/button"
import { Icon, type IconName } from "../components/ui/icon"
import { Text } from "../components/ui/text"
import type { Tab } from "../components/tab-bar"

// Three of the four tabs have nothing to draw until a machine is paired, and
// the handoff answers each one with the reason its own list is empty rather
// than with a shared apology. Settings is the fourth and is not empty at all,
// so it keeps its own screen.
//
// The scan the handoff offers is not in this build: pairing here is the address
// and token the daemon prints, entered under Settings. The sentences that
// promised a camera are the only ones changed.
type Unpaired = {
  title: string
  icon: IconName
  headline: string
  body: string
  footer: string
}

const screens: Record<Exclude<Tab, "settings">, Unpaired> = {
  sessions: {
    title: "Sessions",
    icon: "layers",
    headline: "Nothing runs here yet",
    body: "A session belongs to a machine, so there is nothing for this phone to list until a"
      + " daemon accepts it.",
    footer: "The phone is a client. It never runs an agent itself.",
  },
  review: {
    title: "Review",
    icon: "eye",
    headline: "Nothing to review",
    body: "Diffs, approvals and previews are read from a machine at the moment you open them."
      + " None is paired, so there is nothing to fetch.",
    footer: "Approvals are never parked on a server, so nothing is queued and waiting.",
  },
  fleet: {
    title: "Fleet",
    icon: "server",
    headline: "No machines paired",
    body: "Install the daemon on a computer and run the pair command. The exchange is direct"
      + " between the machine and this phone.",
    footer: "No account is involved in pairing.",
  },
}

export function UnpairedScreen({
  tab,
  bottomInset,
  onPair,
}: {
  tab: Exclude<Tab, "settings">
  bottomInset: number
  // Pairing happens under Settings, which holds the address and the token. The
  // button names the job rather than the screen it opens.
  onPair: () => void
}) {
  const screen = screens[tab]
  return (
    <View className="flex-1 bg-background">
      <View className="px-4 pb-3 pt-2">
        <Text variant="heading">{screen.title}</Text>
        <Text variant="meta" className="mt-[3px]">No machines paired</Text>
      </View>

      <ScrollView
        contentContainerClassName="grow items-center justify-center gap-[11px] px-[26px]"
        contentContainerStyle={{ paddingBottom: bottomInset }}
      >
        <Icon name={screen.icon} tone="faint" size={24} />
        <Text className="text-center font-sans-medium text-[14.5px] text-foreground">
          {screen.headline}
        </Text>
        <Text variant="meta" className="text-center leading-[19px]">{screen.body}</Text>
        <Button
          title="Pair a machine"
          variant="primary"
          onPress={onPair}
          className="mt-0.5 px-4 py-3"
        />
        <Text variant="note" className="text-center text-faint">{screen.footer}</Text>
      </ScrollView>
    </View>
  )
}
