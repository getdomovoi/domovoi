export type WslDistributionState = "Running" | "Stopped"

export type WslDistribution = {
  name: string
  state: WslDistributionState
  version: number
  default: boolean
}

const states = new Set<WslDistributionState>(["Running", "Stopped"])
const byteOrderMark = "﻿"

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

export function parseWslDistributions(output: string | Buffer): WslDistribution[] {
  const [, ...lines] = decode(output).split(/\r?\n/)
  const distributions: WslDistribution[] = []
  for (const line of lines) {
    const distribution = readDistribution(line)
    if (distribution) distributions.push(distribution)
  }
  return distributions
}
