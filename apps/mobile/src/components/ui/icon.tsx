import ArrowDown from "lucide-react-native/icons/arrow-down"
import ArrowUp from "lucide-react-native/icons/arrow-up"
import Ban from "lucide-react-native/icons/ban"
import Camera from "lucide-react-native/icons/camera"
import Check from "lucide-react-native/icons/check"
import ChevronLeft from "lucide-react-native/icons/chevron-left"
import ChevronRight from "lucide-react-native/icons/chevron-right"
import ChevronUp from "lucide-react-native/icons/chevron-up"
import Eye from "lucide-react-native/icons/eye"
import Image from "lucide-react-native/icons/image"
import Layers from "lucide-react-native/icons/layers"
import ListChecks from "lucide-react-native/icons/list-checks"
import Pencil from "lucide-react-native/icons/pencil"
import Pin from "lucide-react-native/icons/pin"
import Plus from "lucide-react-native/icons/plus"
import RotateCw from "lucide-react-native/icons/rotate-cw"
import Server from "lucide-react-native/icons/server"
import Settings from "lucide-react-native/icons/settings"
import Unplug from "lucide-react-native/icons/unplug"
import X from "lucide-react-native/icons/x"

import { useTheme } from "../../theme/theme-provider"

// The design system draws Lucide, so the app draws Lucide rather than symbol
// characters. Instrument Sans has no glyph for ✓, ◆, ◈, ⚙ or ⬡, and iOS answers
// a missing glyph with whichever fallback face has one, which is how a tab bar
// ends up wearing the emoji gear.
const glyphs = {
  "arrow-down": ArrowDown,
  "arrow-up": ArrowUp,
  ban: Ban,
  camera: Camera,
  check: Check,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
  eye: Eye,
  image: Image,
  layers: Layers,
  "list-checks": ListChecks,
  pencil: Pencil,
  pin: Pin,
  plus: Plus,
  "rotate-cw": RotateCw,
  server: Server,
  settings: Settings,
  unplug: Unplug,
  x: X,
}

export type IconName = keyof typeof glyphs

export type IconTone = "primary" | "primary-foreground" | "faint" | "strong" | "muted" | "success" | "warning" | "destructive" | "danger-fg" | "warn-fg"

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
  const { palette } = useTheme()
  const color = tone === "muted" ? palette["muted-foreground"] : palette[tone]
  return <Glyph size={size} strokeWidth={1.5} color={color} />
}
