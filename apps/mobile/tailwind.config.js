/** @type {import("tailwindcss").Config} */
// Every value here is read from apps/mobile/src/theme/tokens.generated.js,
// which scripts/mobile-tokens.mjs renders from packages/ui/src/styles.css: the
// desktop's oklch tokens as the sRGB hex React Native can parse, the radius
// steps derived from --radius, and one registered font name per weight. Edit
// the stylesheet and run pnpm mobile:tokens; release:invariants fails on drift.
const { colors, fontFamily, radius } = require("./src/theme/tokens.generated.js")

// React Native picks a face by its registered name, so each weight is its own
// family and the weight utilities (font-semibold) are not used.
const faces = Object.fromEntries(
  Object.entries(fontFamily).map(([name, face]) => [name, [face]]),
)

module.exports = {
  content: ["./index.ts", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    // The phone follows the desktop's dark theme; it has no light surface yet.
    colors: colors.dark,
    borderRadius: { ...radius, full: "9999px" },
    fontFamily: faces,
    extend: {
      // The nativewind preset registers sans, serif and mono under
      // theme.extend.fontFamily, pointing them at platform fallbacks: on iOS
      // that is the family name "system font", which UIFont cannot resolve, so
      // every font-sans node falls back to Times and every font-mono node to
      // Courier New. Tailwind applies extend after the base theme, so the
      // theme.fontFamily above loses to the preset and only the names the
      // preset does not use survive. Repeating the faces here is what puts the
      // registered ones back: an extend from this config is merged last.
      fontFamily: faces,
      // iOS asks for 44pt minimum touch targets, so the sizes a control can be
      // are named rather than left to whoever writes the next screen.
      minHeight: { tap: "44px" },
      minWidth: { tap: "44px" },
    },
  },
  plugins: [],
}
