import InstrumentSans_400Regular from "@expo-google-fonts/instrument-sans/400Regular/InstrumentSans_400Regular.ttf"
import InstrumentSans_500Medium from "@expo-google-fonts/instrument-sans/500Medium/InstrumentSans_500Medium.ttf"
import InstrumentSans_600SemiBold from "@expo-google-fonts/instrument-sans/600SemiBold/InstrumentSans_600SemiBold.ttf"
import JetBrainsMono_400Regular from "@expo-google-fonts/jetbrains-mono/400Regular/JetBrainsMono_400Regular.ttf"

import type { LoadedFont } from "./tokens.generated"

// Each face is imported by file rather than through the package index, so Metro
// bundles the faces the app registers and not every weight the package ships.
// The key is the name expo-font registers, which is what the generated
// fontFamily utilities ask React Native for; the type keeps the two in step.
export const fontSources: Record<LoadedFont, number> = {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
  JetBrainsMono_400Regular,
}
