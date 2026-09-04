import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  checkMobileTokens,
  customProperties,
  fontFaces,
  oklchToHex,
  parseTokens,
  radiusScale,
  resolveAliases,
  topLevelBlocks,
  writeMobileTokens,
} from "./mobile-tokens.mjs"

const stylesheet = [
  '@import "tailwindcss";',
  '@import "@fontsource-variable/instrument-sans";',
  "",
  "@theme inline {",
  '  --font-sans: "Instrument Sans Variable", ui-sans-serif, sans-serif;',
  "  --font-heading: var(--font-sans);",
  '  --font-mono: "JetBrains Mono Variable", ui-monospace, monospace;',
  "  --color-background: var(--background);",
  "  --radius-sm: calc(var(--radius) - 4px);",
  "  --radius-md: calc(var(--radius) - 3px);",
  "  --radius-lg: calc(var(--radius) - 2px);",
  "  --radius-xl: var(--radius);",
  "  --radius-2xl: 14px;",
  "}",
  "",
  ":root,",
  ".light {",
  "  color-scheme: light;",
  "  --background: oklch(0.995 0.001 285);",
  "  --primary: oklch(0.52 0.2 275);",
  "  --ring: var(--primary);",
  "  --radius: 0.65rem;",
  "  --shell-rail: 62px;",
  "  --shadow-md: 0 10px 30px oklch(0.2 0.01 285 / 0.1);",
  "}",
  "",
  ".dark {",
  "  color-scheme: dark;",
  "  --background: oklch(0.165 0.005 285);",
  "  --primary: oklch(0.72 0.17 275);",
  "  --ring: var(--primary);",
  "  --overlay: oklch(0.11 0.004 285 / 0.78);",
  "}",
  "",
  "@layer base {",
  "  * { @apply border-border; }",
  "  body { font-size: 13px; }",
  "}",
  "",
].join("\n")

const faces = [
  ["@expo-google-fonts/instrument-sans", "400Regular/InstrumentSans_400Regular.ttf"],
  ["@expo-google-fonts/instrument-sans", "500Medium/InstrumentSans_500Medium.ttf"],
  ["@expo-google-fonts/instrument-sans", "600SemiBold/InstrumentSans_600SemiBold.ttf"],
  ["@expo-google-fonts/jetbrains-mono", "400Regular/JetBrainsMono_400Regular.ttf"],
]

async function scratchRepository({ fonts = faces } = {}) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-mobile-tokens-"))
  await mkdir(join(root, "packages", "ui", "src"), { recursive: true })
  await mkdir(join(root, "apps", "mobile", "src", "theme"), { recursive: true })
  await writeFile(join(root, "packages", "ui", "src", "styles.css"), stylesheet)
  for (const [pkg, file] of fonts) {
    const path = join(root, "apps", "mobile", "node_modules", pkg, file)
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, "ttf")
  }
  return root
}

test("finds top-level blocks past @import statements and through nested braces", () => {
  const blocks = topLevelBlocks(stylesheet)
  assert.deepEqual(blocks.map((block) => block.selector), ["@theme inline", ":root, .light", ".dark", "@layer base"])
  assert.match(blocks[3].body, /@apply border-border/)
})

test("resolves var() aliases against the same theme and then the light fallback", () => {
  const light = resolveAliases(customProperties(topLevelBlocks(stylesheet)[1].body))
  assert.equal(light.ring, "oklch(0.52 0.2 275)")
  const dark = resolveAliases({ ring: "var(--primary)", primary: "oklch(0.72 0.17 275)", panel: "var(--radius)" }, light)
  assert.equal(dark.ring, "oklch(0.72 0.17 275)")
  assert.equal(dark.panel, "0.65rem")
  assert.throws(() => resolveAliases({ a: "var(--b)", b: "var(--a)" }), /circular/)
  assert.throws(() => resolveAliases({ a: "var(--missing)" }), /undefined custom property: --missing/)
})

// Expected values come from the CSS Color 4 sample conversion, cross-checked
// against culori 4 for the same oklch input. Primary sits just outside sRGB and
// clips to the same hex a browser paints.
test("converts oklch to the sRGB hex a browser paints", () => {
  assert.equal(oklchToHex("oklch(0.72 0.17 275)"), "#8798ff")
  assert.equal(oklchToHex("oklch(0.165 0.005 285)"), "#0e0e10")
  assert.equal(oklchToHex("oklch(0.63 0.19 25)"), "#e54c4a")
  assert.equal(oklchToHex("oklch(0.79 0.13 62)"), "#f6a65d")
  assert.equal(oklchToHex("oklch(0.52 0.2 275)"), "#4d53d9")
  assert.equal(oklchToHex("oklch(1 0 0)"), "#ffffff")
  assert.equal(oklchToHex("oklch(0.11 0.004 285 / 0.78)"), "#040405c7")
  assert.equal(oklchToHex("0 10px 30px oklch(0.2 0.01 285 / 0.1)"), undefined)
  assert.equal(oklchToHex("0.65rem"), undefined)
})

test("derives the radius scale from --radius the way the @theme block does", () => {
  const theme = topLevelBlocks(stylesheet)[0].body
  assert.deepEqual(radiusScale(theme, { radius: "0.65rem" }), {
    sm: "6.4px",
    md: "7.4px",
    lg: "8.4px",
    xl: "10.4px",
    "2xl": "14px",
  })
  assert.deepEqual(radiusScale(theme, { radius: "0.5rem" }).xl, "8px")
  assert.throws(() => radiusScale(theme, { radius: "10px" }), /rem/)
})

test("names one registered face per weight the design uses", () => {
  const theme = topLevelBlocks(stylesheet)[0].body
  assert.deepEqual(fontFaces(theme).map((face) => [face.utility, face.name, face.file]), [
    ["sans", "InstrumentSans_400Regular", "400Regular/InstrumentSans_400Regular.ttf"],
    ["sans-medium", "InstrumentSans_500Medium", "500Medium/InstrumentSans_500Medium.ttf"],
    ["sans-semibold", "InstrumentSans_600SemiBold", "600SemiBold/InstrumentSans_600SemiBold.ttf"],
    ["mono", "JetBrainsMono_400Regular", "400Regular/JetBrainsMono_400Regular.ttf"],
  ])
  assert.throws(() => fontFaces('--font-sans: "Inter", sans-serif;\n--font-mono: "Menlo";'), /no expo-google-fonts package is mapped for Inter/)
})

test("keeps colours only, with the dark theme inheriting what it does not restate", () => {
  const tokens = parseTokens(stylesheet)
  assert.deepEqual(tokens.colors.light, { background: "#fdfdfe", primary: "#4d53d9", ring: "#4d53d9" })
  assert.deepEqual(tokens.colors.dark, {
    background: "#0e0e10",
    primary: "#8798ff",
    ring: "#8798ff",
    overlay: "#040405c7",
  })
})

test("the check fails until the generated files match the stylesheet, then passes", async () => {
  const root = await scratchRepository()
  assert.deepEqual(await checkMobileTokens(root), [
    "apps/mobile/src/theme/tokens.generated.js: missing; run pnpm mobile:tokens",
    "apps/mobile/src/theme/tokens.generated.d.ts: missing; run pnpm mobile:tokens",
  ])
  await writeMobileTokens(root)
  assert.deepEqual(await checkMobileTokens(root), [])
  const module = await readFile(join(root, "apps", "mobile", "src", "theme", "tokens.generated.js"), "utf8")
  assert.match(module, /^\/\/ Generated by scripts\/mobile-tokens\.mjs/)
  assert.match(module, /primary: "#8798ff",/)
  assert.match(module, /"sans-semibold": "InstrumentSans_600SemiBold",/)
  assert.match(module, /module\.exports = \{ colors, radius, fonts, fontFamily \}\n$/)
  const types = await readFile(join(root, "apps", "mobile", "src", "theme", "tokens.generated.d.ts"), "utf8")
  assert.match(types, /export type LoadedFont = "InstrumentSans_400Regular" \| "InstrumentSans_500Medium" \| "InstrumentSans_600SemiBold" \| "JetBrainsMono_400Regular"/)
  assert.match(types, /readonly "2xl": "14px"/)
  await rm(root, { recursive: true, force: true })
})

test("a token edited in the stylesheet makes the check fail", async () => {
  const root = await scratchRepository()
  await writeMobileTokens(root)
  const stylesheetPath = join(root, "packages", "ui", "src", "styles.css")
  const edited = stylesheet.replace("--primary: oklch(0.72 0.17 275);", "--primary: oklch(0.7 0.17 275);")
  assert.notEqual(edited, stylesheet)
  await writeFile(stylesheetPath, edited)
  assert.deepEqual(await checkMobileTokens(root), [
    "apps/mobile/src/theme/tokens.generated.js: stale relative to packages/ui/src/styles.css; run pnpm mobile:tokens",
    "apps/mobile/src/theme/tokens.generated.d.ts: stale relative to packages/ui/src/styles.css; run pnpm mobile:tokens",
  ])
  await rm(root, { recursive: true, force: true })
})

test("generation refuses a face the installed font package does not ship", async () => {
  const root = await scratchRepository({ fonts: faces.slice(0, 3) })
  await assert.rejects(writeMobileTokens(root), /@expo-google-fonts\/jetbrains-mono\/400Regular\/JetBrainsMono_400Regular\.ttf/)
  await rm(root, { recursive: true, force: true })
})
