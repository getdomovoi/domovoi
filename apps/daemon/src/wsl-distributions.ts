export type WslDistributionState = "Running" | "Stopped"

export type WslDistribution = {
  name: string
  state: WslDistributionState
  version: number
  default: boolean
}

export type WslDaemonTarget = {
  name: string
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

// A distribution name may contain spaces, so the state and version are read
// from the end of the line and everything before them is the name.
function readDistribution(line: string): WslDistribution | undefined {
  const isDefault = line.trimStart().startsWith("*")
  const columns = line.replace(/^\s*\*/, "").trim().split(/\s+/)
  if (columns.length < 3) return undefined

  const version = Number(columns.at(-1))
  const state = columns.at(-2)
  const name = columns.slice(0, -2).join(" ")
  if (!Number.isInteger(version) || state === undefined || !states.has(state as WslDistributionState)) {
    return undefined
  }
  if (name === "") return undefined

  return { name, state: state as WslDistributionState, version, default: isDefault }
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

// Only a running WSL2 distribution can hold a daemon of its own: WSL1 shares the
// Windows network stack, and a stopped distribution is left stopped rather than
// started on the strength of a listing.
export function wslDaemonTargets(distributions: readonly WslDistribution[]): WslDaemonTarget[] {
  return distributions
    .filter((distribution) => distribution.state === "Running" && distribution.version === 2)
    .map((distribution) => ({ name: distribution.name, default: distribution.default }))
    .sort((left, right) => Number(right.default) - Number(left.default))
}
