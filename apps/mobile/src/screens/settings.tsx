import { ScrollView, TextInput, View } from "react-native"

import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Text } from "../components/ui/text"
import type { ConnectionFault } from "../lib/connection-fault"
import type { DaemonStatus } from "../lib/daemon"
import { colors } from "../theme/tokens.generated"

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
}: {
  url: string
  token: string
  status: DaemonStatus
  fault: ConnectionFault | undefined
  onChangeUrl: (value: string) => void
  onChangeToken: (value: string) => void
  onConnect: () => void
  onForget: () => void
}) {
  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-3 p-4 pb-8">
      <Text variant="heading">Settings</Text>

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
            className="min-h-tap rounded-xl border border-border bg-code px-3 font-mono text-[12px] text-foreground"
          />
        </View>
        <View className="gap-1.5">
          <Text variant="label">Pairing token</Text>
          <Text variant="meta">
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
            className="min-h-tap rounded-xl border border-border bg-code px-3 font-mono text-[12px] text-foreground"
          />
        </View>
        <Button title="Connect" variant="primary" onPress={onConnect} />
        <Button title="Forget this daemon" variant="ghost" onPress={onForget} />
        <Text variant="meta">
          {fault && !fault.retriable ? "Not connected, and not trying again" : statusLabel[status]}
        </Text>
        {fault ? (
          <View className="gap-1">
            <Text className="text-[12px] font-sans-semibold text-destructive">{fault.headline}</Text>
            <Text variant="meta" className="text-[11px]">{fault.detail}</Text>
          </View>
        ) : null}
      </Card>

      <Text variant="meta">
        The phone reaches the daemon directly over your tailnet. Nothing is relayed through a
        hosted service. The token is held in this device's keychain, is never copied off it, and
        forgetting the daemon removes it.
      </Text>
    </ScrollView>
  )
}
