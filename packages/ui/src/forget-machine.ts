import type { FleetForgetRefusal, FleetForgetResult, FleetRemoteRevocation } from "@getdomovoi/protocol"

import { pendingOperationNote } from "./fleet-entries.js"

// Every refusal the protocol can name, in this build's words. A reason added
// to the protocol has to decide its copy here before it compiles.
export const forgetRefusalMessage: Record<FleetForgetRefusal, string> = {
  "self-forget": "This machine cannot forget itself",
  "not-enrolled": "That machine is not enrolled here, so there is nothing to forget",
  "credential-store-unavailable": "The keychain on this machine could not be read, so nothing was deleted",
  "fleet-unavailable": "This daemon has no fleet store, so it cannot forget a machine",
  "operation-in-progress": "An enrollment or a forget for that machine is still finishing",
}

// There is no revocation transaction across machines. Unconfirmed means the
// credential here is gone and the target may still accept this machine, so
// the operator is told exactly where to finish the job. It never means the
// target is known to have revoked anything.
export const remoteRevocationNote: Record<FleetRemoteRevocation, (label: string) => string> = {
  confirmed: (label) => `${label} revoked this machine's credential.`,
  unconfirmed: (label) =>
    `${label} did not confirm revoking this machine. Revoke this machine in the Devices list on ${label}.`,
}

export type ForgetMachineNotice = {
  outcome: FleetForgetResult["outcome"]
  title: string
  detail: string
}

export function forgetMachineNotice(result: FleetForgetResult, label: string): ForgetMachineNotice {
  switch (result.outcome) {
    case "forgotten":
      return {
        outcome: "forgotten",
        title: `Forgot ${label}`,
        detail: `This machine no longer holds a credential for it. ${remoteRevocationNote[result.remoteRevocation](label)}`,
      }
    case "pending":
      return {
        outcome: "pending",
        title: `Forgetting ${label}`,
        detail: `${pendingOperationNote}. ${remoteRevocationNote[result.remoteRevocation](label)}`,
      }
    case "refused":
      return {
        outcome: "refused",
        title: `${label} was not forgotten`,
        detail: forgetRefusalMessage[result.reason],
      }
  }
}
