/** @type {import("tailwindcss").Config} */
// The palette is the Claude Design dark theme, converted from its oklch source
// to sRGB because React Native's colour parser does not read oklch. The oklch
// values in design/design_handoff_domovoi are still the source of truth; these
// are the rendering of them.
module.exports = {
  content: ["./index.ts", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: "#0e0e10",
        sidebar: "#121215",
        card: "#17171a",
        accent: "#1e1e21",
        muted: "#252529",
        border: "#2e2f33",
        foreground: "#f1f1f4",
        strong: "#dadadd",
        "muted-foreground": "#919198",
        faint: "#6b6b72",
        code: "#0a0a0c",
        desk: "#040405",
        primary: "#8798ff",
        "primary-foreground": "#0c0e1c",
        success: "#51c88b",
        warning: "#f6a65d",
        destructive: "#e54c4a",
        info: "#67addd",
        "warn-bg": "#2d1905",
        "warn-border": "#60370b",
        "warn-fg": "#ffe6c8",
        "warn-dim": "#d2a883",
        "info-bg": "#121c23",
        "info-border": "#18364a",
        "info-fg": "#b4d6ef",
      },
      borderRadius: { DEFAULT: "10px", lg: "14px", xl: "18px", pill: "999px" },
      fontFamily: {
        sans: ["Instrument Sans", "system-ui", "sans-serif"],
        machine: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      // iOS asks for 44pt minimum touch targets, so the sizes a control can be
      // are named rather than left to whoever writes the next screen.
      minHeight: { tap: "44px" },
      minWidth: { tap: "44px" },
    },
  },
  plugins: [],
}
