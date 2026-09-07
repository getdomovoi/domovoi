import ArrowUp from "lucide-react-native/icons/arrow-up"
import Check from "lucide-react-native/icons/check"
import ChevronLeft from "lucide-react-native/icons/chevron-left"
import ChevronRight from "lucide-react-native/icons/chevron-right"
import Eye from "lucide-react-native/icons/eye"
import Layers from "lucide-react-native/icons/layers"
import Server from "lucide-react-native/icons/server"
import Settings from "lucide-react-native/icons/settings"

import { colors } from "../../theme/tokens.generated"

// The design system draws Lucide, so the app draws Lucide rather than symbol
// characters. Instrument Sans has no glyph for ✓, ◆, ◈, ⚙ or ⬡, and iOS answers
// a missing glyph with whichever fallback face has one, which is how a tab bar
// ends up wearing the emoji gear.
const glyphs = {
  "arrow-up": ArrowUp,
  check: Check,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  eye: Eye,
  layers: Layers,
  server: Server,
  settings: Settings,
}

export type IconName = keyof typeof glyphs

// React Native has no currentColor, so an icon is told its colour outright and
// reads it from the same generated table the class names are built from.
const tones = {
  primary: colors.dark.primary,
  "primary-foreground": colors.dark["primary-foreground"],
  faint: colors.dark.faint,
  strong: colors.dark.strong,
  muted: colors.dark["muted-foreground"],
  success: colors.dark.success,
  "warn-fg": colors.dark["warn-fg"],
}

export type IconTone = keyof typeof tones

export function Icon({
  name,
  tone,
  size = 20,
}: {
  name: IconName
  tone: IconTone
  size?: number
}) {
  const Glyph = glyphs[name]
  return <Glyph size={size} strokeWidth={1.5} color={tones[tone]} />
}
