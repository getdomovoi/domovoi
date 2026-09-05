import { join } from "node:path"

import { claimExclusiveFileLease } from "../file-lease.js"

export class ServiceOperationBusyError extends Error {
  constructor(path: string) {
    super(`Another Domovoi service operation holds ${path}. Wait for that command to finish, then retry. Do not delete the lease file.`)
    this.name = "ServiceOperationBusyError"
  }
}

// Distinct from the runtime profile lease: an install must keep exclusion
// while asking the manager to start a daemon which takes the profile lease.
// Callers always acquire this outer lease first, then the profile lease.
export function claimServiceOperation(userHomeDirectory: string) {
  const path = join(userHomeDirectory, ".domovoi", "service-operation-lease.sqlite")
  return claimExclusiveFileLease(path, () => new ServiceOperationBusyError(path))
}
