import { z } from "zod"

import type { FleetMachine } from "./fleet.js"

// Resolved product decision: a transfer to a machine that is not answering is
// refused at the moment it is asked for. Domovoi never queues a session move,
// because a session must not change hands later, unattended, on a machine the
// user may no longer be near.
export const transferRefusalSchema = z.enum([
  "target-is-source",
  "target-unreachable",
  "target-not-responding",
  "target-pairing-required",
  "target-version-mismatch",
  "target-upgrade-required",
  "target-cannot-run-sessions",
])

export type TransferRefusal = z.infer<typeof transferRefusalSchema>

export const transferRefusalMessage: Record<TransferRefusal, string> = {
  "target-is-source": "That machine already holds this session",
  "target-unreachable": "That machine is unreachable, so the session cannot move to it now",
  "target-not-responding": "That machine is not answering, so the session cannot move to it now",
  "target-pairing-required": "That machine must be paired again before a session can move to it",
  "target-version-mismatch": "That machine runs a newer Domovoi, so this client cannot move a session to it",
  "target-upgrade-required": "That machine runs an older Domovoi and needs an upgrade first",
  "target-cannot-run-sessions": "That machine does not run sessions",
}

export const transferPreflightSchema = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }).strict(),
  z.object({ allowed: z.literal(false), reason: transferRefusalSchema }).strict(),
])

export type TransferPreflight = z.infer<typeof transferPreflightSchema>

function refuse(reason: TransferRefusal): TransferPreflight {
  return { allowed: false, reason }
}

export function transferPreflight(input: {
  source: FleetMachine
  target: FleetMachine
}): TransferPreflight {
  const { source, target } = input
  if (target.id === source.id) return refuse("target-is-source")

  switch (target.health) {
    case "unreachable":
      return refuse("target-unreachable")
    case "degraded":
    case "reconnecting":
      return refuse("target-not-responding")
    case "version-mismatch":
      return refuse("target-version-mismatch")
    case "upgrade-required":
      return refuse("target-upgrade-required")
    case "healthy":
      break
  }

  if (!target.capabilities.includes("sessions")) return refuse("target-cannot-run-sessions")
  return { allowed: true }
}
