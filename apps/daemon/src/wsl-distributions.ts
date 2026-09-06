export type WslDistributionState = "Running" | "Stopped"

export type WslDistribution = {
  name: string
  state: WslDistributionState
  version: number
  default: boolean
}

// A corrupt listing has no usable rows, even if some could be read. Keeping
// only the cause and line number keeps partial discovery and untrusted row
// contents out of a result the caller might otherwise mistake for a list.
export type WslDistributionListing =
  | { kind: "listed"; distributions: WslDistribution[] }
  | { kind: "corrupt"; reason: "encoding" | "header" | "row"; line: number }

const states = new Set<WslDistributionState>(["Running", "Stopped"])
const byteOrderMark = "﻿"
const header = /^\s*NAME\s+STATE\s+VERSION\s*$/i

// wsl.exe writes its listing as UTF-16 with a byte order mark, so reading it as
// UTF-8 leaves a NUL between every character and matches nothing.
function decode(output: string | Buffer): string {
  const text = typeof output === "string" ? output : output.toString("utf16le")
  return text.startsWith(byteOrderMark) ? text.slice(byteOrderMark.length) : text
}

// A distribution name may contain spaces, and repeated ones, so the state and
// version are matched at the end of the line and the name is whatever precedes
// them, left exactly as it was registered.
const row = /^(?<name>.*?)\s+(?<state>\S+)\s+(?<version>\d+)\s*$/

function readDistribution(line: string): WslDistribution | undefined {
  const isDefault = line.trimStart().startsWith("*")
  const columns = row.exec(line.replace(/^\s*\*?\s*/, ""))
  const groups = columns?.groups
  if (!groups) return undefined

  const name = groups["name"] ?? ""
  const state = groups["state"] ?? ""
  if (name === "" || !states.has(state as WslDistributionState)) return undefined
  const version = Number(groups["version"])
  if (!Number.isSafeInteger(version) || version < 1) return undefined

  return {
    name,
    state: state as WslDistributionState,
    version,
    default: isDefault,
  }
}

export function parseWslDistributions(output: string | Buffer): WslDistributionListing {
  const [first, ...lines] = decode(output).split(/\r?\n/)
  // Buffer's UTF-16 decoder silently drops a trailing half character. That
  // could erase the only evidence of a row after an otherwise empty header.
  if (typeof output !== "string" && output.length % 2 !== 0) {
    return { kind: "corrupt", reason: "encoding", line: lines.length + 1 }
  }
  if (!header.test(first ?? "")) return { kind: "corrupt", reason: "header", line: 1 }

  const distributions: WslDistribution[] = []
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue
    const distribution = readDistribution(line)
    if (!distribution) return { kind: "corrupt", reason: "row", line: index + 2 }
    distributions.push(distribution)
  }
  return { kind: "listed", distributions }
}
