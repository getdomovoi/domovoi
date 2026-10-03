import Svg, { Path } from "react-native-svg"

import { useTheme } from "../theme/theme-provider"

// The Domovoi mark, from design/assets/mark-reduced.svg (#514), the file the
// v2 designs mask in its brand colour. React Native cannot load an SVG file as
// an image, so its two paths are drawn here. The design's launch frame draws a
// working variant, mark-working.svg, which the repository does not carry; the
// reduced mark stands in there too.
//
// Every place the mark is drawn today has a heading or the wordmark beside it
// that already names the screen, so by default it is decoration and a screen
// reader skips it. A caller that draws it alone passes the label it should
// announce.
export function Mark({ size, label }: { size: number, label?: string }) {
  const { palette } = useTheme()
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
      <Path
        d="M50 4C67 4 79 14 81 31C83 45 88 60 84 73C79 87 66 96 50 96C34 96 21 87 16 73C12 60 17 45 19 31C21 14 33 4 50 4ZM50 16C60 16 67 22 67 32C67 43 60 51 50 51C40 51 33 43 33 32C33 22 40 16 50 16Z"
        fill={palette.primary}
        fillRule="evenodd"
      />
      <Path
        d="M36.4 32a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0 -9.2 0ZM54.4 32a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0 -9.2 0Z"
        fill={palette.primary}
      />
    </Svg>
  )
}
