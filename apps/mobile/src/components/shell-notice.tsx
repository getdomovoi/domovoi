import { View } from "react-native"

import { cn } from "../lib/cn"
import type { UnreachableShell } from "../shell-state"
import { PageScroller } from "./page-scroller"
import { Button } from "./ui/button"
import { Card } from "./ui/card"
import { Icon, type IconName } from "./ui/icon"
import { Text } from "./ui/text"

// A phone that cannot see a daemon is not a broken screen. The handoff gives it
// the whole screen: what was tried, what came back, and the one thing worth
// pressing. It refuses to guess at session state, so nothing else is drawn.
const marks: Record<UnreachableShell["kind"], { icon: IconName, tone: "faint" | "destructive" }> = {
  restoring: { icon: "layers", tone: "faint" },
  refused: { icon: "unplug", tone: "destructive" },
  reaching: { icon: "unplug", tone: "faint" },
}

// A credential the daemon has refused is fixed in one place. The other two are
// the phone still working, where a button would only offer to interrupt it.
const settled: ReadonlySet<UnreachableShell["kind"]> = new Set(["refused"])

// Retrying is only worth offering where a retry can change the answer. A
// credential the daemon refused gives the same answer to every attempt.
const retriable: ReadonlySet<UnreachableShell["kind"]> = new Set(["reaching"])

export function ShellNotice({
  shell,
  address,
  bottomInset,
  onOpenSettings,
  onRetry,
}: {
  shell: UnreachableShell
  // The one route this phone has. Named on screen because a wrong address and
  // a machine that is asleep look identical from here.
  address: string
  bottomInset: number
  onOpenSettings: () => void
  onRetry: () => void
}) {
  const mark = marks[shell.kind]
  const unreachable = shell.kind === "reaching" || shell.kind === "refused"
  return (
    <View className="flex-1 bg-background">
      <View className="px-4 pb-3 pt-2">
        <Text variant="heading">Sessions</Text>
        <Text
          variant="meta"
          className={cn("mt-[3px]", shell.kind === "refused" && "text-danger-dim")}
        >
          {unreachable ? "No daemon reachable" : shell.headline}
        </Text>
      </View>

      <PageScroller
        contentContainerClassName="grow items-center justify-center gap-3 px-6"
        bottomInset={bottomInset}
      >
        <Icon name={mark.icon} tone={mark.tone} size={24} />
        <Text className="text-center font-sans-medium text-[14.5px] text-foreground">
          {shell.headline}
        </Text>
        <Text variant="meta" className="text-center leading-[19px]">{shell.detail}</Text>

        {address ? (
          <Card flush className="w-full">
            <View className="flex-row items-baseline gap-2.5 px-3 py-2.5">
              <Text variant="label" className="text-[10.5px]">Address</Text>
              <Text
                variant="machine"
                className="flex-1 text-right text-[10.5px]"
                numberOfLines={1}
              >
                {address}
              </Text>
            </View>
          </Card>
        ) : null}

        {retriable.has(shell.kind) ? (
          <>
            <Button
              title="Retry now"
              variant="outline"
              onPress={onRetry}
              className="mt-1 px-4 py-3"
            />
            <Text variant="note" className="text-center text-faint">
              Retrying on its own, with a longer gap after each attempt, up to thirty seconds.
            </Text>
          </>
        ) : null}

        {settled.has(shell.kind) ? (
          <Button title="Settings" onPress={onOpenSettings} className="mt-1 px-4 py-3" />
        ) : null}
      </PageScroller>
    </View>
  )
}
