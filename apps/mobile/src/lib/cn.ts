import { colors, fontFamily } from "../theme/tokens.generated"

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
    if (/^\[.+\]$/.test(value)) return "size"
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

export function cn(...parts: Array<string | false | null | undefined>): string {
  const classes = parts.filter(Boolean).join(" ").split(/\s+/).filter(Boolean)
  const winner = new Map<string, number>()
  classes.forEach((className, index) => {
    const group = conflictGroup(className)
    if (group !== undefined) winner.set(group, index)
  })
  return classes
    .filter((className, index) => {
      const group = conflictGroup(className)
      return group === undefined || winner.get(group) === index
    })
    .join(" ")
}
