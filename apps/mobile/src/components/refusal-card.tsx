import { View } from "react-native"

import type { PhoneRefusal } from "../session-refusal"
import { Button } from "./ui/button"
import { Card } from "./ui/card"
import { Text } from "./ui/text"

// Skills design step 16: a start the daemon refused over a repository git
// filter, where the person asked for it. The facts stack and keep their full
// text. The phone cannot trust, so the foot says where trust is granted, and
// says "Trust from desktop or web" only where trust would lift the refusal
// (ruling Q214's rule for the Tools screen footer). The design draws the
// refusal with the danger family, as the desktop card: Domovoi refused, which
// is not inventory state.
export function RefusalCard({ refusal, onSeeHeldBack }: { refusal: PhoneRefusal, onSeeHeldBack: () => void }) {
  return (
    <Card flush accessibilityLabel={refusal.title} className="border-danger-border bg-danger-bg">
      <View className="gap-1.5 px-[13px] py-3">
        <View className="flex-row items-center gap-2">
          <View testID="refusal-dot" className="size-[7px] rounded-full bg-destructive" />
          <Text className="font-sans-medium text-[13px] text-danger-fg">{refusal.title}</Text>
        </View>
        <Text variant="machine" className="text-danger-dim">{refusal.code}</Text>
        <Text variant="meta" className="text-danger-fg">{refusal.sentence}</Text>
        <View className="flex-row flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <Text variant="meta" className="text-danger-dim">It names</Text>
          {refusal.names.map((name) => <Text key={name} variant="machine" className="text-danger-fg">{name}</Text>)}
          {refusal.omitted > 0 ? <Text variant="meta" className="text-danger-dim">{`and ${refusal.omitted} more`}</Text> : null}
        </View>
        <Text variant="meta" className="text-danger-dim">Nothing from the repository ran.</Text>
        <Button title="See what is held back" className="self-start" onPress={onSeeHeldBack} />
      </View>
      <View className="gap-0.5 border-t border-danger-border px-[13px] py-2.5">
        {refusal.awaitsTrust ? <Text className="font-sans-medium text-[13px] text-danger-fg">Trust from desktop or web</Text> : null}
        <Text variant="note" className="text-danger-dim">A phone shows this but cannot trust it.</Text>
      </View>
    </Card>
  )
}
