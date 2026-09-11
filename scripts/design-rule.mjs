import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "..")
const manifestFile = "design/design_system_domovoi/_adherence.oxlintrc.json"
const typographyFile = "design/design_system_domovoi/tokens/typography.css"
const phoneStylesheet = "packages/ui/src/styles.css"
const outputFile = "eslint.type-floor.generated.mjs"
const regenerateCommand = "pnpm design:rule"

// The small-type floor, derived rather than restated. A hand-written selector
// encodes today's numbers and drifts the moment the design system moves them,
// which is the failure this repository has already paid for twice: the design
// guide's prose contradicted its own tokens, and a regex claim about those
// tokens was wrong. The manifest names which tokens are fonts and the
// stylesheet gives their values, so the rule can be computed from both instead
// of describing them.

export function fontTokenSizes(manifest, typography) {
  const kinds = manifest["x-omelette"]?.tokenKinds
  if (!kinds) throw new Error(`${manifestFile}: no x-omelette.tokenKinds; the manifest is the authority for which tokens are fonts`)
  const declared = new Map()
  for (const match of typography.matchAll(/(?:^|\s)(--[a-z0-9-]+)\s*:\s*([^;]+);/gmu)) {
    declared.set(match[1], match[2].trim())
  }
  const sizes = new Map()
  const missing = []
  for (const [token, kind] of Object.entries(kinds)) {
    if (kind !== "font") continue
    const value = declared.get(token)
    // A token the manifest calls a font and the stylesheet never defines would
    // silently leave a hole in the rule. Say so instead.
    if (value === undefined) { missing.push(token); continue }
    const pixels = /^(\d+(?:\.\d+)?)px$/u.exec(value)
    if (pixels) sizes.set(token, Number(pixels[1]))
  }
  if (missing.length > 0) {
    throw new Error(`${typographyFile}: ${missing.join(", ")} marked "font" in ${manifestFile} but never defined; run ${regenerateCommand} after re-vendoring`)
  }
  return sizes
}

// Everything at or above the floor is ordinary. Below it, only the tokens the
// system actually names are legal, so the smallest named one is the boundary a
// raw value has to clear.
export function floorFrom(sizes) {
  const floor = sizes.get("--text-micro")
  if (floor === undefined) throw new Error(`${typographyFile}: --text-micro is the floor and is not defined`)
  const named = [...sizes.entries()].filter(([, size]) => size < floor)
  if (named.length === 0) throw new Error(`${typographyFile}: no named role below --text-micro; the rule would ban every value under the floor`)
  const smallest = Math.min(...named.map(([, size]) => size))
  return { floor, smallest, named: named.map(([token, size]) => ({ token, size })).sort((a, b) => a.size - b.size) }
}

// Matches a decimal strictly below the boundary. Kept to a single leading digit
// on purpose: the moment a floor needs two, this throws rather than emitting a
// pattern nobody checked.
export function belowPattern(boundary) {
  const whole = Math.floor(boundary)
  const fraction = Math.round((boundary - whole) * 10)
  // Number.EPSILON is the gap at 1, not at 10, so it cannot judge a scaled
  // comparison. Round-tripping the value is what actually asks whether it has
  // one decimal place.
  // The class below spans 0 to whole - 1, so a whole boundary of 10 still yields
  // the single-digit [0-9]. A fractional one above 10 would need a two-digit
  // literal beside it, and that stays refused: the caution here is about not
  // emitting a pattern nobody checked, not about what a regex can express.
  if (whole > 10 || (whole === 10 && fraction > 0) || Math.round(boundary * 10) / 10 !== boundary) {
    throw new Error(`${outputFile}: cannot express "below ${boundary}px" as a single-digit pattern; extend belowPattern before moving the floor`)
  }
  const alternatives = []
  if (whole > 0) alternatives.push(`[0-${whole - 1}](?:\\\\.\\\\d+)?`)
  // Only when the boundary has a fractional part is the whole number itself
  // partly below it. On a whole-pixel boundary the first alternative already
  // covers everything under it, and the bare digit would match the boundary
  // the pattern exists to exclude.
  if (fraction > 0) alternatives.push(`${whole}(?:\\\\.[0-${fraction - 1}]\\\\d*)?`)
  if (alternatives.length === 0) throw new Error(`${outputFile}: nothing is below ${boundary}px; the rule would ban nothing`)
  return alternatives.join("|")
}

// The phone's floor, derived from its own source. styles.css is authoritative
// for the phone ramp exactly as design/tokens/typography.css is for the
// desktop's, and the two describe different scales rather than one restating the
// other, so neither can drift from the other. A phone has less width, so its
// steps are smaller; that is layout pressure and not legibility, and its floor
// is therefore higher than the desktop's rather than lower.
export function phoneFloorFrom(stylesheet) {
  const sizes = new Map()
  for (const match of stylesheet.matchAll(/--text-phone-([a-z0-9-]+)\s*:\s*([\d.]+)px\s*;/gu)) {
    if (match[1].endsWith("-lh")) continue
    sizes.set(match[1], Number(match[2]))
  }
  if (sizes.size === 0) {
    throw new Error(`${phoneStylesheet}: no --text-phone-* roles; the phone rule would ban nothing`)
  }
  const floor = Math.min(...sizes.values())
  const roles = [...sizes.entries()]
    .filter(([, size]) => size === floor)
    .map(([role]) => `text-${role}`)
    .sort()
  return { floor, roles }
}

export async function generate(root = repositoryRoot) {
  const manifest = JSON.parse(await readFile(join(root, manifestFile), "utf8"))
  const typography = await readFile(join(root, typographyFile), "utf8")
  const sizes = fontTokenSizes(manifest, typography)
  const { floor, smallest, named } = floorFrom(sizes)
  const utilities = { "--text-eyebrow": "text-eyebrow", "--text-mono-xs": "text-mono-xs", "--text-micro": "text-micro" }
  const names = named.map(({ token }) => utilities[token] ?? token)
  const roles = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0]
  // Each message names the floor it enforced and where that floor is declared.
  // A phone failure that pointed at the desktop tokens would send someone to a
  // ramp their file does not use.
  const message = `Text below ${smallest}px has no token behind it on the desktop scale. Use ${roles} for a named role below ${floor}px, or ${utilities["--text-micro"]} for sans prose. Declared in ${typographyFile}.`
  const pattern = `text-\\\\[(?:${belowPattern(smallest)})px\\\\]`
  const phone = phoneFloorFrom(await readFile(join(root, phoneStylesheet), "utf8"))
  const phoneRoles = phone.roles.length > 1
    ? `${phone.roles.slice(0, -1).join(", ")} or ${phone.roles[phone.roles.length - 1]}`
    : phone.roles[0]
  const phoneMessage = `Text below ${phone.floor}px has no token behind it on the phone scale, and nothing sits below ${phoneRoles}. A hardcoded size under the floor stops responding to iOS Dynamic Type and Android font scaling. Declared as --text-phone-* in ${phoneStylesheet}.`
  const phonePattern = `text-\\\\[(?:${belowPattern(phone.floor)})px\\\\]`
  const module = [
    `// Generated by ${regenerateCommand}. Do not edit.`,
    `//`,
    `// Derived from ${manifestFile}, which names which tokens are fonts, and`,
    `// ${typographyFile}, which gives their values. The floor is --text-micro at`,
    `// ${floor}px; the named roles below it are ${named.map(({ token, size }) => `${token} ${size}px`).join(", ")}.`,
    `// A raw value under ${smallest}px has no token behind it at all.`,
    `export const typeFloorRules = [`,
    `  {`,
    `    selector: "Literal[value=/${pattern}/]",`,
    `    message: ${JSON.stringify(message)},`,
    `  },`,
    `  {`,
    `    selector: "TemplateElement[value.raw=/${pattern}/]",`,
    `    message: ${JSON.stringify(message)},`,
    `  },`,
    `]`,
    ``,
    `// The phone's ramp is its own scale, declared in ${phoneStylesheet} and read`,
    `// from there rather than from the design system, which carries the desktop's`,
    `// and knows nothing about the phone's. Its floor is ${phone.floor}px with no role`,
    `// beneath it.`,
    `export const phoneTypeFloorRules = [`,
    `  {`,
    `    selector: "Literal[value=/${phonePattern}/]",`,
    `    message: ${JSON.stringify(phoneMessage)},`,
    `  },`,
    `  {`,
    `    selector: "TemplateElement[value.raw=/${phonePattern}/]",`,
    `    message: ${JSON.stringify(phoneMessage)},`,
    `  },`,
    `]`,
    ``,
  ].join("\n")
  return { module, floor, smallest, named, phone }
}

export async function writeDesignRule(root = repositoryRoot) {
  const generated = await generate(root)
  await writeFile(join(root, outputFile), generated.module)
  return generated
}

export async function checkDesignRule(root = repositoryRoot) {
  const generated = await generate(root)
  let actual
  try { actual = await readFile(join(root, outputFile), "utf8") } catch { actual = undefined }
  if (actual === undefined) return [`${outputFile}: missing; run ${regenerateCommand}`]
  if (actual !== generated.module) return [`${outputFile}: stale relative to ${manifestFile}; run ${regenerateCommand}`]
  return []
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--check")) {
    const failures = await checkDesignRule()
    for (const failure of failures) console.error(failure)
    if (failures.length > 0) process.exitCode = 1
    else console.log(`${outputFile} matches ${manifestFile}`)
  } else {
    const { floor, smallest, named, phone } = await writeDesignRule()
    console.log(`wrote a desktop floor of ${floor}px with ${named.length} named roles below it, banning under ${smallest}px, and a phone floor of ${phone.floor}px with none below it, to ${outputFile}`)
  }
}
