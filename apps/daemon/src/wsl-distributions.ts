export type WslDistributionState = "Running" | "Stopped"

export type WslDistribution = {
  name: string
  state: WslDistributionState
  version: number
  default: boolean
}

// A corrupt listing has no usable rows, even if some could be read. Keeping
// only the line number makes it impossible to mistake partial discovery for
// a complete list, or repeat untrusted row contents in an operator message.
export type WslDistributionListing =
  | { kind: "listed"; distributions: WslDistribution[] }
  | { kind: "corrupt"; line: number }

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

  return {
    name,
    state: state as WslDistributionState,
    version: Number(groups["version"]),
    default: isDefault,
  }
}

export function parseWslDistributions(output: string | Buffer): WslDistributionListing {
  const [first, ...lines] = decode(output).split(/\r?\n/)
  if (!header.test(first ?? "")) return { kind: "corrupt", line: 1 }

  const distributions: WslDistribution[] = []
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue
    const distribution = readDistribution(line)
    if (!distribution) return { kind: "corrupt", line: index + 2 }
    distributions.push(distribution)
  }
  return { kind: "listed", distributions }
}
