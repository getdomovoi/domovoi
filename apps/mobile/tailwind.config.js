/** @type {import("tailwindcss").Config} */
// Every value here is read from apps/mobile/src/theme/tokens.generated.js,
// which scripts/mobile-tokens.mjs renders from packages/ui/src/styles.css: the
// desktop's oklch tokens as the sRGB hex React Native can parse, the radius
// steps derived from --radius, and one registered font name per weight. Edit
// the stylesheet and run pnpm mobile:tokens; release:invariants fails on drift.
const { colors, fontFamily, radius } = require("./src/theme/tokens.generated.js")

module.exports = {
  content: ["./index.ts", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    // The phone follows the desktop's dark theme; it has no light surface yet.
    colors: colors.dark,
    borderRadius: { ...radius, full: "9999px" },
    // React Native picks a face by its registered name, so each weight is its
    // own family and the weight utilities (font-semibold) are not used.
    fontFamily: Object.fromEntries(Object.entries(fontFamily).map(([name, face]) => [name, [face]])),
    extend: {
      // iOS asks for 44pt minimum touch targets, so the sizes a control can be
      // are named rather than left to whoever writes the next screen.
      minHeight: { tap: "44px" },
      minWidth: { tap: "44px" },
    },
  },
  plugins: [],
}
