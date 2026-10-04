import Svg, { Path } from "react-native-svg"

import { useTheme } from "../theme/theme-provider"

// The Domovoi mark, from design/assets/mark.svg and mark-reduced.svg (#514).
// React Native cannot load an SVG file as an image, so their paths are drawn
// here. The brand handoff (design/design_handoff_domovoi_brand/README.md,
// "Size behaviour") picks the form by rendered size: the full mark, eyes and
// mustache, at 28px and above, and the reduced mark, larger eyes and no
// mustache, below, because mid-face detail turns to mud.
//
// The working variant (ruling Q386 A) follows the brand handoff's "Working
// state" section: "Working state widens the eyes to r 3.8." Nothing else
// changes, so the eyes keep mark.svg's centres, (42, 31) and (58, 31), and the
// mustache stays. The handoff lists mark-working.svg as an asset to produce,
// but no such file is vendored, so this path is built from that sentence. The
// handoff defines the state on the full form only; below 28px the reduced form
// is drawn whatever the variant. The state's 34% primary glow belongs to the
// field behind the mark ("never on the mark") and is not drawn here.
//
// Every place the mark is drawn today has a heading or the wordmark beside it
// that already names the screen, so by default it is decoration and a screen
// reader skips it. A caller that draws it alone passes the label it should
// announce.

const face = "M50 4C67 4 79 14 81 31C83 45 88 60 84 73C79 87 66 96 50 96C34 96 21 87 16 73C12 60 17 45 19 31C21 14 33 4 50 4ZM50 16C60 16 67 22 67 32C67 43 60 51 50 51C40 51 33 43 33 32C33 22 40 16 50 16Z"

const features = {
  full: "M38.7 31a3.3 3.3 0 1 0 6.6 0a3.3 3.3 0 1 0 -6.6 0ZM54.7 31a3.3 3.3 0 1 0 6.6 0a3.3 3.3 0 1 0 -6.6 0ZM34 43C40 40 45 43 50 43C55 43 60 40 66 43C59 50 54 47 50 47C46 47 41 50 34 43Z",
  reduced: "M36.4 32a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0 -9.2 0ZM54.4 32a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0 -9.2 0Z",
  working: "M38.2 31a3.8 3.8 0 1 0 7.6 0a3.8 3.8 0 1 0 -7.6 0ZM54.2 31a3.8 3.8 0 1 0 7.6 0a3.8 3.8 0 1 0 -7.6 0ZM34 43C40 40 45 43 50 43C55 43 60 40 66 43C59 50 54 47 50 47C46 47 41 50 34 43Z",
} as const

export type MarkForm = keyof typeof features
export type MarkVariant = "working"

export function markForm(size: number, variant?: MarkVariant): MarkForm {
  if (size < 28) return "reduced"
  return variant ?? "full"
}

export function markFeatures(form: MarkForm): string {
  return features[form]
}

export function Mark({ size, label, variant }: { size: number, label?: string, variant?: MarkVariant }) {
  const { palette } = useTheme()
  const form = markForm(size, variant)
  const announced = label
    ? { accessible: true, accessibilityRole: "image" as const, accessibilityLabel: label }
    : { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const }
  return (
    <Svg
      testID="domovoi-mark"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      {...announced}
    >
      <Path d={face} fill={palette.primary} fillRule="evenodd" />
      <Path testID={`domovoi-mark-${form}`} d={features[form]} fill={palette.primary} />
    </Svg>
  )
}
