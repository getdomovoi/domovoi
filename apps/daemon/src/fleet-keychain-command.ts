import { machineIdSchema } from "@getdomovoi/protocol"
import type { MachineCredentials } from "./machine-credentials.js"

const usage = "Usage: domovoid fleet-keychain list\n       domovoid fleet-keychain forget <machine-id> --confirm-daemon-stopped\nStop Domovoi and its supervisor before local-only removal. This does not revoke the credential on the target.\n"

export function runFleetKeychainCommand(
  args: string[],
  input: { credentials: MachineCredentials; stdout(text: string): void; stderr(text: string): void },
): number {
  if (args.length === 2 && args[1] === "--help") { input.stdout(usage); return 0 }
  const list = args.length === 2 && args[1] === "list"
  const forget = args.length === 4 && args[1] === "forget" && args[3] === "--confirm-daemon-stopped"
  if (!list && !forget) { input.stderr(usage); return 1 }
  if (forget && !machineIdSchema.safeParse(args[2]).success) {
    input.stderr("Invalid machine identity. Use an id from domovoid fleet-keychain list.\n")
    return 1
  }
  try {
    if (list) {
      // This local recovery command intentionally bypasses the wire list cap.
      // List identity metadata only, without loading any credential bytes.
      const ids = machineIdSchema.array().parse(input.credentials.machines())
      for (const id of [...new Set(ids)].sort()) input.stdout(`${id}\n`)
    } else {
      const id = args[2]!
      // The explicit confirmation is an operator assertion, not proof that
      // the daemon stopped. The supervisor must be stopped too, or it could
      // resume a journal and race this exceptional local keychain repair.
      input.credentials.forget(id)
      if (input.credentials.forMachine(id) !== undefined || input.credentials.machines().includes(id)) {
        throw new Error("Local keychain removal is incomplete")
      }
      input.stdout(`Removed local credential and index entry for ${id}. Remote revocation is unconfirmed; revoke this machine in the target's Devices list. Existing fleet facts are not removed by this local repair.\n`)
    }
    return 0
  } catch {
    // Native keyring failures and invalid argv must never echo secret bytes.
    input.stderr("Local keychain operation did not complete. Unlock the keychain, list the index again, and retry with Domovoi stopped.\n")
    return 1
  }
}
