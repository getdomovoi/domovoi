import { join } from "node:path"

import { claimExclusiveFileLease } from "./file-lease.js"

export class ProfileAlreadyOwnedError extends Error {
  constructor(directory: string) {
    super(`Domovoi profile at ${directory} is already owned. Close Desktop or stop the running daemon, start the service, then reopen Desktop.`)
    this.name = "ProfileAlreadyOwnedError"
  }
}

export type ProfileLease = { release(): void }

const liveHandles = new WeakSet<ProfileLease>()

export function assertProfileLeaseHeld(lease: ProfileLease): void {
  if (!liveHandles.has(lease)) throw new Error("Profile metadata mutation requires a held profile lease")
}

export function claimProfile(homeDirectory: string): ProfileLease {
  const directory = join(homeDirectory, ".domovoi")
  const file = claimExclusiveFileLease(join(directory, "profile-lease.sqlite"), () => new ProfileAlreadyOwnedError(directory))
  const lease: ProfileLease = {
    release: () => {
      file.release()
      liveHandles.delete(lease)
    },
  }
  liveHandles.add(lease)
  return lease
}
