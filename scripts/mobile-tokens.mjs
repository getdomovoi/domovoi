import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
const sourceFile = "packages/ui/src/styles.css"
const outputDirectory = "apps/mobile/src/theme"
const moduleFile = `${outputDirectory}/tokens.generated.js`
const typesFile = `${outputDirectory}/tokens.generated.d.ts`
const mobileDirectory = "apps/mobile"
const regenerateCommand = "pnpm mobile:tokens"

// React Native reads neither oklch nor CSS custom properties, so the phone gets
// the desktop stylesheet rendered down to sRGB hex, pixel radii, and the
// per-weight font names expo-font registers. This script is the only path from
// styles.css to the phone: a hand-copied palette drifts silently, a generated
// one either matches byte for byte or fails release:invariants.

// The faces the design uses. DESIGN.md sets body and machine text at 400,
// labels at 500, and titles at 600. React Native names a font per face rather
// than per family, so each weight the app can ask for has to be its own
// registered name; a weight missing from this list has no face to land on.
const fontPackages = {
  "Instrument Sans": { package: "@expo-google-fonts/instrument-sans", prefix: "InstrumentSans" },
  "JetBrains Mono": { package: "@expo-google-fonts/jetbrains-mono", prefix: "JetBrainsMono" },
}
const fontWeights = { sans: [400, 500, 600], mono: [400] }
const weightStyles = { 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold" }
const weightUtilities = { 400: "", 500: "-medium", 600: "-semibold", 700: "-bold" }

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "")
}

// Top-level rules only: selector text paired with the body between its braces,
// nested braces included. @layer and @media bodies come back whole, which is
// enough because the tokens live at the top level.
export function topLevelBlocks(css) {
  const source = stripComments(css)
  const blocks = []
  let index = 0
  while (index < source.length) {
    const open = source.indexOf("{", index)
    if (open === -1) break
    const preamble = source.slice(index, open)
    // Anything before the last semicolon is an @import or similar statement.
    const selector = preamble.slice(preamble.lastIndexOf(";") + 1).trim()
    let depth = 1
    let cursor = open + 1
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "{") depth += 1
      else if (source[cursor] === "}") depth -= 1
      cursor += 1
    }
    blocks.push({ selector: selector.split(/\s*,\s*/).join(", "), body: source.slice(open + 1, cursor - 1) })
    index = cursor
  }
  return blocks
}

export function customProperties(body) {
  const properties = {}
  for (const match of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    properties[match[1]] = match[2].trim()
  }
  return properties
}

// Aliases like `--secondary: var(--accent)` resolve within the theme that
// declares them, falling back to the light block for anything the dark block
// leaves alone, which is how the cascade reads them in the browser.
export function resolveAliases(properties, fallback = {}) {
  const resolved = {}
  const resolveOne = (name, seen = []) => {
    if (seen.includes(name)) throw new Error(`circular custom property: --${name}`)
    const value = properties[name] ?? fallback[name]
    if (value === undefined) throw new Error(`undefined custom property: --${name}`)
    return value.replace(/var\(--([\w-]+)\)/g, (_, inner) => resolveOne(inner, [...seen, name]))
  }
  for (const name of Object.keys(properties)) resolved[name] = resolveOne(name)
  return resolved
}

function gamma(channel) {
  const magnitude = Math.abs(channel)
  const encoded = magnitude <= 0.0031308 ? 12.92 * magnitude : 1.055 * magnitude ** (1 / 2.4) - 0.055
  return Math.sign(channel) * encoded
}

// The CSS Color 4 reference pipeline: oklch to oklab, oklab to LMS, LMS to
// linear sRGB, then the sRGB transfer curve. Channels outside 0..1 are clipped,
// which is what a browser does when it paints an oklch colour onto an sRGB
// surface.
export function oklchToSrgb(lightness, chroma, hue) {
  const radians = (hue * Math.PI) / 180
  const a = chroma * Math.cos(radians)
  const b = chroma * Math.sin(radians)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return linear.map((channel) => Math.min(1, Math.max(0, gamma(channel))))
}

function hexByte(value) {
  return Math.round(value * 255).toString(16).padStart(2, "0")
}

export function parseOklch(value) {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/.exec(value)
  if (!match) return undefined
  const alphaText = match[4]
  const alpha = alphaText === undefined
    ? 1
    : alphaText.endsWith("%") ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText)
  return { lightness: Number(match[1]), chroma: Number(match[2]), hue: Number(match[3]), alpha }
}

export function oklchToHex(value) {
  const parsed = parseOklch(value)
  if (!parsed) return undefined
  const [r, g, b] = oklchToSrgb(parsed.lightness, parsed.chroma, parsed.hue)
  const rgb = `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`
  return parsed.alpha < 1 ? `${rgb}${hexByte(parsed.alpha)}` : rgb
}

export function themeColors(resolved) {
  const colors = {}
  for (const [name, value] of Object.entries(resolved)) {
    const hex = oklchToHex(value)
    if (hex) colors[name] = hex
  }
  return colors
}

function pxValue(text, radius) {
  const trimmed = text.trim()
  if (trimmed === "var(--radius)") return radius
  const literal = /^([\d.]+)px$/.exec(trimmed)
  if (literal) return Number(literal[1])
  const calc = /^calc\(var\(--radius\)\s*([+-])\s*([\d.]+)px\)$/.exec(trimmed)
  if (calc) return calc[1] === "-" ? radius - Number(calc[2]) : radius + Number(calc[2])
  throw new Error(`unsupported radius expression: ${trimmed}`)
}

function formatPx(value) {
  return `${Number(value.toFixed(2))}px`
}

// The desktop derives every corner from --radius in the @theme block. Reading
// those expressions rather than restating them means a change to the base
// radius or one of its steps reaches the phone by regeneration alone.
export function radiusScale(themeBlock, rootProperties) {
  const base = /^([\d.]+)rem$/.exec(rootProperties.radius ?? "")
  if (!base) throw new Error(`--radius must be a rem value, got ${rootProperties.radius}`)
  const radius = Number(base[1]) * 16
  const scale = {}
  for (const [name, value] of Object.entries(customProperties(themeBlock))) {
    const step = /^radius-(.+)$/.exec(name)
    if (step) scale[step[1]] = formatPx(pxValue(value, radius))
  }
  return scale
}

function firstFamily(stack) {
  const quoted = /^"([^"]+)"/.exec(stack.trim())
  return (quoted ? quoted[1] : stack.split(",")[0].trim()).replace(/ Variable$/, "")
}

export function fontFaces(themeBlock) {
  const theme = customProperties(themeBlock)
  const faces = []
  for (const [utility, weights] of Object.entries(fontWeights)) {
    const stack = theme[`font-${utility}`]
    if (!stack) throw new Error(`--font-${utility} is not declared in ${sourceFile}`)
    const family = firstFamily(stack)
    const source = fontPackages[family]
    if (!source) throw new Error(`no expo-google-fonts package is mapped for ${family}`)
    for (const weight of weights) {
      const style = weightStyles[weight]
      const name = `${source.prefix}_${weight}${style}`
      faces.push({
        utility: `${utility}${weightUtilities[weight]}`,
        family,
        weight,
        name,
        package: source.package,
        file: `${weight}${style}/${name}.ttf`,
      })
    }
  }
  return faces
}

export function parseTokens(css) {
  const blocks = topLevelBlocks(css)
  const find = (selector) => {
    const block = blocks.find((candidate) => candidate.selector === selector)
    if (!block) throw new Error(`${sourceFile} has no ${selector} block`)
    return block.body
  }
  const light = resolveAliases(customProperties(find(":root, .light")))
  const darkOwn = customProperties(find(".dark"))
  const dark = resolveAliases(darkOwn, light)
  const theme = find("@theme inline")
  return {
    colors: { light: themeColors(light), dark: themeColors(dark) },
    radius: radiusScale(theme, light),
    fonts: fontFaces(theme),
  }
}

function literal(value) {
  return JSON.stringify(value)
}

function key(name) {
  return /^[a-z_$][\w$]*$/i.test(name) ? name : literal(name)
}

function objectLines(record, indent) {
  return Object.entries(record).map(([name, value]) => `${indent}${key(name)}: ${literal(value)},`)
}

const header = [
  `// Generated by scripts/mobile-tokens.mjs from ${sourceFile}. Do not edit.`,
  `// Run ${regenerateCommand} after changing the stylesheet; release:invariants`,
  "// fails when this file and the stylesheet disagree.",
]

export function renderModule(tokens) {
  const fontFamily = Object.fromEntries(tokens.fonts.map((face) => [face.utility, face.name]))
  return [
    ...header,
    '"use strict"',
    "",
    "const colors = {",
    "  light: {",
    ...objectLines(tokens.colors.light, "    "),
    "  },",
    "  dark: {",
    ...objectLines(tokens.colors.dark, "    "),
    "  },",
    "}",
    "",
    "const radius = {",
    ...objectLines(tokens.radius, "  "),
    "}",
    "",
    "const fonts = [",
    ...tokens.fonts.map((face) => `  ${JSON.stringify(face)},`),
    "]",
    "",
    "const fontFamily = {",
    ...objectLines(fontFamily, "  "),
    "}",
    "",
    "module.exports = { colors, radius, fonts, fontFamily }",
    "",
  ].join("\n")
}

function typeLines(record, indent) {
  return Object.entries(record).map(([name, value]) => `${indent}readonly ${key(name)}: ${literal(value)}`)
}

export function renderTypes(tokens) {
  const fontFamily = Object.fromEntries(tokens.fonts.map((face) => [face.utility, face.name]))
  const names = tokens.fonts.map((face) => literal(face.name)).join(" | ")
  const utilities = tokens.fonts.map((face) => literal(face.utility)).join(" | ")
  return [
    ...header,
    "",
    `export type LoadedFont = ${names}`,
    `export type FontUtility = ${utilities}`,
    "export interface FontFace {",
    "  readonly utility: FontUtility",
    "  readonly family: string",
    "  readonly weight: number",
    "  readonly name: LoadedFont",
    "  readonly package: string",
    "  readonly file: string",
    "}",
    "",
    "export declare const colors: {",
    "  readonly light: {",
    ...typeLines(tokens.colors.light, "    "),
    "  }",
    "  readonly dark: {",
    ...typeLines(tokens.colors.dark, "    "),
    "  }",
    "}",
    "export declare const radius: {",
    ...typeLines(tokens.radius, "  "),
    "}",
    "export declare const fonts: readonly FontFace[]",
    "export declare const fontFamily: {",
    ...typeLines(fontFamily, "  "),
    "}",
    "",
  ].join("\n")
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
}

// A face the tokens name but the package does not ship would register nothing
// and fall back to the platform font, which is the bug this script exists to
// remove. Checking the file on disk keeps that from being a device-only find.
export async function missingFontFiles(tokens, root = repositoryRoot) {
  const missing = []
  for (const face of tokens.fonts) {
    const path = join(root, mobileDirectory, "node_modules", face.package, face.file)
    try {
      await access(path)
    } catch {
      missing.push(`${face.package}/${face.file}`)
    }
  }
  return missing
}

export async function generate(root = repositoryRoot) {
  const css = await readFile(join(root, sourceFile), "utf8")
  const tokens = parseTokens(css)
  const missing = await missingFontFiles(tokens, root)
  if (missing.length > 0) {
    throw new Error(`font files not installed under ${mobileDirectory}/node_modules:\n  ${missing.join("\n  ")}`)
  }
  return { tokens, module: renderModule(tokens), types: renderTypes(tokens) }
}

export async function checkMobileTokens(root = repositoryRoot) {
  const { module: expectedModule, types: expectedTypes } = await generate(root)
  const failures = []
  for (const [file, expected] of [[moduleFile, expectedModule], [typesFile, expectedTypes]]) {
    const actual = await readOptional(join(root, file))
    if (actual === undefined) failures.push(`${file}: missing; run ${regenerateCommand}`)
    else if (actual !== expected) failures.push(`${file}: stale relative to ${sourceFile}; run ${regenerateCommand}`)
  }
  return failures
}

export async function writeMobileTokens(root = repositoryRoot) {
  const generated = await generate(root)
  await mkdir(join(root, outputDirectory), { recursive: true })
  await writeFile(join(root, moduleFile), generated.module)
  await writeFile(join(root, typesFile), generated.types)
  return generated.tokens
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--check")) {
    const failures = await checkMobileTokens()
    for (const failure of failures) console.error(failure)
    if (failures.length > 0) process.exitCode = 1
    else console.log(`${moduleFile} matches ${sourceFile}`)
  } else {
    const tokens = await writeMobileTokens()
    const count = Object.keys(tokens.colors.dark).length
    console.log(`wrote ${count} colours, ${Object.keys(tokens.radius).length} radii, ${tokens.fonts.length} faces to ${moduleFile}`)
  }
}
