import { colors, fontFamily, fontSize } from "../theme/tokens.generated"

// NativeWind does not resolve a conflict the way the className string reads. It
// sorts the matched rules by CSS specificity and, on a tie, by the order the
// rule was written into the compiled stylesheet, which Tailwind sorts by class
// name. text-[10px] is written before text-[13px], so a component base of
// text-[13px] beat a caller's text-[10px] whichever way the two were joined.
// The conflict is settled here instead, by dropping the classes a later one
// supersedes and handing NativeWind only the winner.
//
// The groups are the ones this app overrides. A class outside them passes
// through untouched, and so does anything carrying a variant prefix, because
// active:opacity-70 next to opacity-60 is a condition rather than a conflict.
const colourNames = new Set([...Object.keys(colors.dark), "transparent"])
const faceNames = new Set(Object.keys(fontFamily))
// text-machine and the other named roles are sizes as much as text-[10px] is,
// and the generated map is the list of them, so a role added to the ramp is
// recognised here without a second list to keep in step.
const sizeNames = new Set(Object.keys(fontSize))
const edges = ["", "x", "y", "t", "r", "b", "l"]

function colourGroup(property: string, value: string): string | undefined {
  return colourNames.has(value.split("/")[0] ?? "") ? property : undefined
}

function conflictGroup(className: string): string | undefined {
  if (className.includes(":")) return undefined
  const dash = className.indexOf("-")
  if (dash === -1) return undefined
  const prefix = className.slice(0, dash)
  const value = className.slice(dash + 1)
  if (prefix === "text") {
    if (/^\[.+\]$/.test(value) || sizeNames.has(value)) return "size"
    if (["left", "center", "right", "justify"].includes(value)) return "align"
    return colourGroup("color", value)
  }
  if (prefix === "font") return faceNames.has(value) ? "face" : undefined
  if (prefix === "bg") return colourGroup("background-color", value)
  if (prefix === "border") return colourGroup("border-color", value)
  if (prefix === "leading") return "line-height"
  if (prefix === "tracking") return "letter-spacing"
  if (prefix === "opacity") return "opacity"
  if (prefix === "gap") return "gap"
  if (edges.includes(prefix.slice(1)) && prefix.startsWith("p")) return `padding-${prefix}`
  if (edges.includes(prefix.slice(1)) && prefix.startsWith("m")) return `margin-${prefix}`
  return undefined
}

// A named role can carry a line height with its size. When a bracketed size
// replaces the role, the role's line height would go with it, though the
// caller only asked to change the size; it is carried over as a leading class
// unless the caller set one. A role replacing a role brings its own.
function roleLineHeight(className: string): string | undefined {
  const size = fontSize[className.slice("text-".length) as keyof typeof fontSize]
  return Array.isArray(size) ? size[1] : undefined
}

export function cn(...parts: Array<string | false | null | undefined>): string {
  const classes = parts.filter(Boolean).join(" ").split(/\s+/).filter(Boolean)
  const winner = new Map<string, number>()
  classes.forEach((className, index) => {
    const group = conflictGroup(className)
    if (group !== undefined) winner.set(group, index)
  })
  const kept = classes.filter((className, index) => {
    const group = conflictGroup(className)
    return group === undefined || winner.get(group) === index
  })
  const size = winner.get("size")
  if (size !== undefined && !winner.has("line-height") && /^text-\[.+\]$/.test(classes[size]!)) {
    const carried = classes
      .filter((className, index) => index < size && conflictGroup(className) === "size")
      .map(roleLineHeight)
      .filter((lineHeight): lineHeight is string => lineHeight !== undefined)
      .at(-1)
    if (carried !== undefined) kept.push(`leading-[${carried}]`)
  }
  return kept.join(" ")
}
