import { existsSync } from "node:fs"
import { userInfo } from "node:os"

import { readLocalOwnerRecord } from "./local-owner-record.js"
import { localOwnerRemovalReceiptPath, writeLocalOwnerRemovalReceipt } from "./local-owner-removal.js"
import { OperationDeadline } from "./operation-deadline.js"
import { claimProfile, type ProfileLease } from "./profile-lease.js"
import { serviceConfigurationPath } from "./service/configuration.js"

const usage = "Usage: domovoid profile recover --confirm-no-supervisor\nThis confirms that no service or custom supervisor will restart this profile. Stop and remove those supervisors first.\n"

export function runProfileCommand(args: readonly string[], input: {
  homeDirectory: string
  stdout(text: string): void
  stderr(text: string): void
}): number {
  if (args.length !== 3 || args[0] !== "profile" || args[1] !== "recover" || args[2] !== "--confirm-no-supervisor") {
    input.stderr(usage)
    return 1
  }
  const deadline = OperationDeadline.start(5_000)
  let lease: ProfileLease | undefined
  try {
    deadline.throwIfExpired()
    lease = claimProfile(input.homeDirectory)
    const record = readLocalOwnerRecord(input.homeDirectory)
    const configuration = serviceConfigurationPath(input.homeDirectory, process.platform)
    if (existsSync(configuration)) throw new Error(`Saved service configuration still exists at ${configuration}. Run domovoid service remove before confirming that no supervisor will restart the daemon.`)
    if (!record || record.state === "none") {
      input.stdout("No unresolved owner record needs recovery. No receipt was written.\n")
      return 0
    }
    const receipt = {
      version: 1 as const, instanceId: record.instanceId, machineId: record.machineId,
      completedAt: new Date().toISOString(),
      authorization: { kind: "operator" as const, confirmation: "no-supervisor-will-restart" as const, username: userInfo().username },
    }
    deadline.throwIfExpired()
    writeLocalOwnerRemovalReceipt(input.homeDirectory, lease, receipt)
    input.stdout(`Recorded your no-supervisor confirmation for owner instance ${record.instanceId} at ${localOwnerRemovalReceiptPath(input.homeDirectory)}. No daemon was started. Reopen Desktop to recover this profile.\n`)
    return 0
  } catch (error) {
    input.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    lease?.release()
    deadline.clear()
  }
}
