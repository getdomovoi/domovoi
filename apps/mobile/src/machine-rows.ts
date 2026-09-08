import {
  machinePlatformLabel,
  type FleetConnectionKind,
  type FleetEntry,
  type FleetHealth,
  type FleetMachine,
  type FleetPendingOperation,
} from "@getdomovoi/protocol"

import type { MachineActivity } from "./machine-activity"
import { elapsedLabel } from "./session-rows"

export type MachineStat = {
  label: string
  value: string
  // An approval is waiting behind this number, which is the one thing on the
  // line worth a colour.
  attention: boolean
}

export type MachineRow = {
  id: string
  label: string
  platform: string
  health: "ok" | "busy" | "gone"
  // Every machine row carries a badge. A state that wants something from a
  // person says so, and everything else says how the machine is reached, which
  // is the next most useful thing to know about one that answers.
  badge: string
  // A sentence where a badge alone would mislead: the two credential states
  // have different remedies, a machine that has stopped answering says when it
  // was last heard from, and a lifecycle row has no facts to show.
  note: string | undefined
  // Empty for every machine but the one this phone is connected to. Nothing in
  // fleet.list counts another machine's sessions or tools.
  stats: MachineStat[]
  // The only sessions this phone can open are the connected daemon's, and
  // nothing in the protocol wakes a machine that has stopped answering, so a
  // row offers nothing rather than a button that would do nothing.
  action: "open" | undefined
}

// Every route the daemon can report has a word here, so a connection kind added
// to the protocol fails to compile until the phone decides what to call it.
const routes: Record<FleetConnectionKind, string> = {
  local: "Local",
  lan: "LAN",
  tailnet: "Tailnet",
  ssh: "SSH",
  relay: "Relay",
  wsl: "WSL",
  direct: "Direct",
}

// Every health the daemon can report has a badge decision here, undefined
// included, so a state added to the protocol fails to compile until the phone
// decides what to say about it. Undefined hands the badge to the route.
const badges: Record<FleetHealth, string | undefined> = {
  healthy: undefined,
  degraded: "Not responding",
  unreachable: "Offline",
  "version-mismatch": "Update this device",
  "upgrade-required": "Upgrade needed",
  reconnecting: "Reconnecting",
  "pairing-required": "Pair again",
  "credential-store-unavailable": "Keychain unavailable",
}

const tones: Record<FleetHealth, MachineRow["health"]> = {
  healthy: "ok",
  reconnecting: "busy",
  degraded: "gone",
  unreachable: "gone",
  "version-mismatch": "busy",
  "upgrade-required": "busy",
  // The target answered and refused, so the machine is as gone as unreachable
  // until someone pairs it again from the daemon, not from this phone.
  "pairing-required": "gone",
  // Nothing was presented, so nothing is known about the target yet.
  "credential-store-unavailable": "busy",
}

type NoteInput = { label: string, lastSeen: string | undefined }

const notes: Record<FleetHealth, ((input: NoteInput) => string) | undefined> = {
  healthy: undefined,
  reconnecting: undefined,
  degraded: ({ label, lastSeen }) => sentence(`${label} is not responding.`, lastSeen),
  unreachable: ({ label, lastSeen }) => sentence(`${label} cannot be reached.`, lastSeen),
  "version-mismatch": undefined,
  "upgrade-required": undefined,
  "pairing-required": ({ label }) =>
    `${label} refused the credential the daemon holds for it. Pair it again from the daemon to restore it.`,
  "credential-store-unavailable": ({ label }) =>
    `The daemon's keychain could not be read, so nothing was presented to ${label}. Pairing again would not fix it.`,
}

const pendingWord: Record<FleetPendingOperation["operation"], string> = {
  enroll: "Enrolling",
  forget: "Forgetting",
}

function sentence(said: string, lastSeen: string | undefined): string {
  return lastSeen === undefined ? said : `${said} ${lastSeen}.`
}

// When the machine was last heard from, in the same short form an approval's
// age uses. Absent when the daemon sent a timestamp this phone cannot read: an
// age is worth showing but not worth inventing.
function lastSeenLabel(iso: string, now: number): string | undefined {
  const age = elapsedLabel(iso, now)
  if (age === undefined) return undefined
  return age === "now" ? "Last seen just now" : `Last seen ${age} ago`
}

function shortMachineId(machineId: string): string {
  return `${machineId.slice(0, 16)}…`
}

function statsFor(machine: FleetMachine, activity: MachineActivity | undefined): MachineStat[] {
  // Matched on the id rather than on `self`, so a snapshot and a fleet list
  // that disagree about which machine this is show nothing rather than putting
  // one machine's work on another machine's card.
  if (!activity || activity.machineId !== machine.id) return []
  return [
    { label: "Sessions", value: String(activity.sessions), attention: false },
    { label: "Tools", value: activity.tools, attention: activity.attention },
  ]
}

function machineRow(
  machine: FleetMachine,
  now: number,
  activity: MachineActivity | undefined,
): MachineRow {
  return {
    id: machine.id,
    label: machine.label,
    // A daemon inside WSL reports linux, which would not tell two distributions
    // apart, so the protocol's own label for a platform is what goes here.
    platform: `${machinePlatformLabel(machine)} · ${machine.arch} · ${machine.version}`,
    health: tones[machine.health],
    badge: badges[machine.health]
      ?? (machine.self ? "This daemon" : routes[machine.connection]),
    note: notes[machine.health]?.({
      label: machine.label,
      lastSeen: lastSeenLabel(machine.heartbeat.lastSeenAt, now),
    }),
    stats: statsFor(machine, activity),
    action: machine.self ? "open" : undefined,
  }
}

// One row per lifecycle kind. Each case returns, so a kind the protocol adds
// later fails to compile here instead of rendering nothing.
function entryRow(
  entry: FleetEntry,
  now: number,
  activity: MachineActivity | undefined,
): MachineRow {
  switch (entry.kind) {
    case "machine":
      return machineRow(entry.machine, now, activity)
    case "pending":
      return {
        id: entry.machineId,
        label: pendingWord[entry.operation],
        platform: shortMachineId(entry.machineId),
        health: "busy",
        badge: "In progress",
        note: "This daemon resumes it on its own.",
        stats: [],
        action: undefined,
      }
    case "unenrolled":
      return {
        id: entry.machineId,
        label: "Never enrolled",
        platform: shortMachineId(entry.machineId),
        health: "gone",
        badge: "Unenrolled",
        note: "A credential exists but this machine was never enrolled. Pair it again from the daemon to enroll it.",
        stats: [],
        action: undefined,
      }
  }
}

export function machineRows(
  entries: FleetEntry[],
  now: number,
  activity?: MachineActivity,
): MachineRow[] {
  return entries.map((entry) => entryRow(entry, now, activity))
}

// The line under the Fleet title: how many machines answer, how many have
// stopped, and how many are in a state that wants a person. Only the counts
// that are not zero are said, and an empty fleet has no line at all because the
// list below already says so.
export function fleetSummary(entries: FleetEntry[]): string | undefined {
  if (entries.length === 0) return undefined
  let reachable = 0
  let offline = 0
  let attention = 0
  for (const entry of entries) {
    if (entry.kind !== "machine") attention += 1
    else if (entry.machine.health === "healthy") reachable += 1
    else if (entry.machine.health === "unreachable") offline += 1
    else attention += 1
  }
  return [
    reachable > 0 ? `${reachable} reachable` : undefined,
    offline > 0 ? `${offline} offline` : undefined,
    attention > 0 ? `${attention} need${attention === 1 ? "s" : ""} attention` : undefined,
  ].filter((part) => part !== undefined).join(" · ")
}
