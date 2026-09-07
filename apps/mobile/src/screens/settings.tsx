import { ScrollView, TextInput, View } from "react-native"

import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Text } from "../components/ui/text"
import { cn } from "../lib/cn"
import type { ConnectionFault } from "../lib/connection-fault"
import type { DaemonStatus } from "../lib/daemon"
import { colors } from "../theme/tokens.generated"

// The four the handoff lists. They configure a machine rather than a phone, so
// an unpaired phone cannot reach any of them. The handoff keeps them on screen
// rather than hiding them, so what pairing buys is visible before it is done.
const machineScoped = [
  "Agents and models",
  "Permission allow list",
  "Skills",
  "Machine defaults",
] as const

const statusLabel: Record<DaemonStatus, string> = {
  connecting: "Connecting",
  open: "Connected",
  closed: "Not connected",
}

export function SettingsScreen({
  url,
  token,
  status,
  fault,
  onChangeUrl,
  onChangeToken,
  onConnect,
  onForget,
  paired,
  bottomInset,
}: {
  url: string
  token: string
  status: DaemonStatus
  fault: ConnectionFault | undefined
  onChangeUrl: (value: string) => void
  onChangeToken: (value: string) => void
  onConnect: () => void
  onForget: () => void
  // Whether this phone has a daemon to talk to at all. Device settings work
  // either way; the machine-scoped ones do not exist until one is paired.
  paired: boolean
  // What the floating tab bar covers, so the list can pad by exactly that.
  bottomInset: number
}) {
  return (
    <View className="flex-1 bg-background">
      <View className="px-4 pb-3 pt-2">
        <Text variant="heading">Settings</Text>
        {paired ? null : <Text variant="meta" className="mt-[3px]">No machines paired</Text>}
      </View>

      <ScrollView
        contentContainerClassName="gap-[9px] px-3"
        contentContainerStyle={{ paddingBottom: bottomInset }}
      >
        <Text variant="label" className="px-1">This phone</Text>

        <Card className="gap-3">
          <View className="gap-1.5">
            <Text variant="label">Daemon address</Text>
            <TextInput
              value={url}
              onChangeText={onChangeUrl}
              autoCapitalize="none"
              autoCorrect={false}
              inputMode="url"
              placeholder="ws://workshop.tailnet:47831/rpc"
              placeholderTextColor={colors.dark.faint}
              // Left unset, iOS tints the caret and the selection with its own
              // system blue, which is the one accent on the screen that is not
              // this product's.
              selectionColor={colors.dark.primary}
              className="min-h-tap rounded-md border border-border bg-code px-3 font-mono text-[11px] text-foreground"
            />
          </View>
          <View className="gap-1.5">
            <Text variant="label">Pairing token</Text>
            <Text variant="note">
              This token can do anything you can do on that machine: send work to an agent, approve
              a command, and open a terminal. Treat it like the machine's keys.
            </Text>
            <TextInput
              value={token}
              onChangeText={onChangeToken}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholderTextColor={colors.dark.faint}
              selectionColor={colors.dark.primary}
              className="min-h-tap rounded-md border border-border bg-code px-3 font-mono text-[11px] text-foreground"
            />
          </View>
          <Button title="Connect" variant="primary" shape="block" onPress={onConnect} />
          <Button title="Forget this daemon" variant="ghost" shape="block" onPress={onForget} />
          <Text variant="note">
            {fault && !fault.retriable ? "Not connected, and not trying again" : statusLabel[status]}
          </Text>
          {fault ? (
            <View className="gap-1">
              <Text className="font-sans-medium text-[11.5px] text-destructive">{fault.headline}</Text>
              <Text variant="note">{fault.detail}</Text>
            </View>
          ) : null}
        </Card>

        <Text variant="note" className="px-1">
          The phone reaches the daemon directly over your tailnet. Nothing is relayed through a
          hosted service. The token is held in this device's keychain, is never copied off it, and
          forgetting the daemon removes it.
        </Text>

        {/* Listed, dimmed and not touchable. Hiding them would leave the screen
            looking finished when it is not, and making them tappable would
            offer a screen that cannot exist without a machine behind it. */}
        {paired ? null : (
          <View className="mt-1.5 gap-[7px]">
            <Text variant="label" className="px-1">Needs a paired machine</Text>
            <Card flush>
              {machineScoped.map((label, index) => (
                <View
                  key={label}
                  accessibilityLabel={`${label}, unavailable`}
                  className={cn(
                    "flex-row items-center gap-2.5 px-[13px] py-3 opacity-50",
                    index > 0 && "border-t border-border",
                  )}
                >
                  <Text className="flex-1 text-[12.5px]">{label}</Text>
                  <Text className="font-mono text-[9.5px] uppercase tracking-[0.06em] text-faint">
                    Unavailable
                  </Text>
                </View>
              ))}
            </Card>
            <Text variant="note" className="px-1 text-faint">
              These live on the machine, not on this phone. They stay listed so you can see what
              pairing unlocks.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  )
}
