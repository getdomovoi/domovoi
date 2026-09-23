import { Component, type ErrorInfo, type ReactNode } from "react"
import { View } from "react-native"

import { Button } from "./ui/button"
import { Text } from "./ui/text"

type State = { error: Error | undefined, attempt: number }

// Provider-written markdown, plans and diffs are drawn from data this app did
// not write. One that throws would otherwise unmount the whole tree, and a
// release build closes on that, then closes again on reopen while the same
// data is on screen. This keeps the app open and says what failed.
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: undefined, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Domovoi could not draw this screen", error, info.componentStack)
  }

  override render() {
    if (this.state.error) {
      return (
        <View className="flex-1 justify-center gap-4 bg-background px-6">
          <Text variant="title">Domovoi could not draw this screen</Text>
          <Text variant="meta">{this.state.error.message}</Text>
          <Text variant="note">
            The failure is in this app. The daemon and its sessions keep running on the machine.
          </Text>
          <Button
            title="Try again"
            variant="primary"
            shape="block"
            onPress={() => this.setState((held) => ({ error: undefined, attempt: held.attempt + 1 }))}
          />
        </View>
      )
    }
    return <View key={this.state.attempt} className="flex-1">{this.props.children}</View>
  }
}
