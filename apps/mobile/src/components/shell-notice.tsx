import { View } from "react-native"

import { cn } from "../lib/cn"
import type { ShellState } from "../shell-state"
import { Button } from "./ui/button"
import { Card } from "./ui/card"
import { Text } from "./ui/text"

// A phone with no workspace to draw is not a broken screen, it is a screen with
// one thing on it. The handoff gives that shape to the pairing card: a dashed
// card that says what is missing and where it is put right, so the state reads
// as a step rather than as a failure.
const dots: Record<ShellState["kind"], string> = {
  restoring: "bg-faint",
  unpaired: "bg-faint",
  refused: "bg-destructive",
  reaching: "bg-warning",
  ready: "bg-success",
}

// Two of these states are fixed in the same place, and the other two are the
// phone still working, where a button would only offer to interrupt it.
const settled: ReadonlySet<ShellState["kind"]> = new Set(["unpaired", "refused"])

export function ShellNotice({
  shell,
  onOpenSettings,
}: {
  shell: ShellState
  onOpenSettings: () => void
}) {
  return (
    <View className="flex-1 justify-center px-3">
      <Card className="border-dashed">
        <View className="flex-row items-center gap-2.5">
          <View className={cn("h-[7px] w-[7px] rounded-full", dots[shell.kind])} />
          <Text variant="nav" className="flex-1">{shell.headline}</Text>
        </View>
        <Text variant="note" className="mt-1.5 pl-[17px]">{shell.detail}</Text>
        {settled.has(shell.kind) ? (
          <View className="mt-3 pl-[17px]">
            <Button title="Settings" onPress={onOpenSettings} className="self-start" />
          </View>
        ) : null}
      </Card>
    </View>
  )
}
