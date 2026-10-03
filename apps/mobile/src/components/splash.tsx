import { View } from "react-native"

import { Mark } from "./mark"
import { Text } from "./ui/text"

// The launch screen the handoff draws: the mark over the wordmark. The design
// draws the mark's working variant here, mark-working.svg, which the
// repository does not carry, so the full mark from design/assets (#514), the
// form the brand handoff gives this size, stands in rather than a variant
// nobody designed.
//
// This is the only screen that draws before the faces are registered, so the
// wordmark can come up in the platform face for the moment the gate is open.
// Naming a face here rather than a family would ask React Native to synthesise
// a weight, which the app does nowhere.
export function Splash() {
  return (
    <View className="flex-1 bg-background">
      <View className="flex-1 items-center justify-center gap-[18px] px-[34px] pb-14">
        <Mark size={62} />
        <Text className="font-sans-semibold text-[25px] leading-[25px] tracking-[-0.025em]">
          Domovoi
        </Text>
      </View>
      <View className="px-[30px] pb-[34px]">
        <Text variant="note" className="text-center text-faint">
          Keys stay in the keychain on this phone. Nothing is fetched from a server on launch.
        </Text>
      </View>
    </View>
  )
}
