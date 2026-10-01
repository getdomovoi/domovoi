import { View } from "react-native"

import type { PhoneRefusal } from "../session-refusal"
import { Button } from "./ui/button"
import { Card } from "./ui/card"
import { Text } from "./ui/text"

// Skills design step 16: a start the daemon refused over a repository git
// filter, where the person asked for it. The facts stack and keep their full
// text. The phone cannot trust, so the foot says where trust is granted, and
// says "Trust from desktop or web" only where trust would lift the refusal
// (ruling Q214's rule for the Tools screen footer).
export function RefusalCard({ refusal, onSeeHeldBack }: { refusal: PhoneRefusal, onSeeHeldBack: () => void }) {
  return (
    <Card flush accessibilityLabel={refusal.title}>
      <View className="gap-1.5 px-[13px] py-3">
        <Text className="font-sans-medium text-[13px] text-foreground">{refusal.title}</Text>
        <Text variant="machine" className="text-faint">{refusal.code}</Text>
        <Text variant="meta">{refusal.sentence}</Text>
        <View className="flex-row flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <Text variant="meta">It names</Text>
          {refusal.names.map((name) => <Text key={name} variant="machine" className="text-strong">{name}</Text>)}
          {refusal.omitted > 0 ? <Text variant="meta">{`and ${refusal.omitted} more`}</Text> : null}
        </View>
        <Text variant="meta">Nothing from the repository ran.</Text>
        <Button title="See what is held back" className="self-start" onPress={onSeeHeldBack} />
      </View>
      <View className="gap-0.5 border-t border-border px-[13px] py-2.5">
        {refusal.awaitsTrust ? <Text className="font-sans-medium text-[13px] text-foreground">Trust from desktop or web</Text> : null}
        <Text variant="note">A phone shows this but cannot trust it.</Text>
      </View>
    </Card>
  )
}
