import {
  maximumRepositoryGitFilterDriverNameLength,
  maximumRepositoryGitFilterDrivers,
  repositoryGitFilterDriverNameSchema,
  repositoryGitFilterErrorCode,
  repositoryGitFilterRefusalSchema,
  type RepositoryGitFilterRefusal,
} from "@getdomovoi/protocol"

import { redactInventoryText } from "./inventory-redaction.js"
import { projectRootRead, repositoryTrustState } from "./repository-trust-apply.js"
import type { RepositoryTrustGrant } from "./repository-trust-store.js"
import { readRepositoryProviderConfig } from "./repository-provider-config.js"
import { PublicRpcError } from "./rpc-errors.js"
import type { RepositoryProviderConfigReader } from "./tool-inventory.js"
import type { RepositoryFilterRefusedError } from "./workspace.js"

// An operation refused because Git would run a filter the repository's own
// Git config sets (a new session's checkout, or a checkpoint, restore, revert
// or transfer), answered with the drivers and the repository's trust against
// its configuration read now, as tool.inventory and the trust step read it
// (ruling Q145 A). Never an earlier answer: the trust shown is the one a
// review would start from.
export class RepositoryGitFilterRpcError extends PublicRpcError {
  constructor(message: string, readonly data: RepositoryGitFilterRefusal) {
    super(repositoryGitFilterErrorCode, message)
    this.name = "RepositoryGitFilterRpcError"
  }
}

// The refusal with its data, or undefined when the configuration cannot be
// read now or the data does not fit the protocol: the caller then keeps the
// refusal's text alone. A driver name is shown redacted, as tool.inventory
// shows it; one the protocol still refuses is counted, not named.
export async function repositoryGitFilterRpcError(input: {
  error: RepositoryFilterRefusedError
  project: { id: string; path: string }
  grant: RepositoryTrustGrant | undefined
  read?: RepositoryProviderConfigReader | undefined
}): Promise<RepositoryGitFilterRpcError | undefined> {
  const read = input.read ?? readRepositoryProviderConfig
  let config: Awaited<ReturnType<RepositoryProviderConfigReader>>
  try {
    // The root as its sessions read it, with the filters the refused command's
    // worktree read in place of the root's own, so the digest and trust
    // describe the configuration that was refused (an onbranch include or a
    // config.worktree can make the two differ).
    config = await read(input.project.path, { ...projectRootRead, gitFilters: input.error.settings })
  } catch {
    return undefined
  }
  const drivers: RepositoryGitFilterRefusal["drivers"] = []
  let omittedDrivers = 0
  for (const { name, scope } of input.error.drivers) {
    const shown = redactInventoryText(name, maximumRepositoryGitFilterDriverNameLength)
    if (drivers.length < maximumRepositoryGitFilterDrivers && repositoryGitFilterDriverNameSchema.safeParse(shown).success) drivers.push({ name: shown, scope })
    else omittedDrivers += 1
  }
  const data = repositoryGitFilterRefusalSchema.safeParse({
    kind: "repository-git-filter",
    projectId: input.project.id,
    configDigest: config.configDigest,
    trust: repositoryTrustState(config, input.grant),
    drivers,
    omittedDrivers,
  })
  return data.success ? new RepositoryGitFilterRpcError(input.error.message, data.data) : undefined
}
