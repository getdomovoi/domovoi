import {
  repositoryGitFilterErrorCode,
  repositoryGitFilterRefusalSchema,
  type RepositoryGitFilterRefusal,
} from "@getdomovoi/protocol"

import { DaemonRpcError } from "./client"

// A session.create or session.fork the daemon refused because checking the
// repository out would run a git filter its own Git config sets. The data is
// read with its schema: an answer this build cannot read stays an ordinary
// failure with the daemon's sentence, never a card that guesses. Codex's own
// refusal of a worktree's .codex config reaches clients as prose with no code,
// so it is not read here.
export function gitFilterRefusalFrom(error: unknown): RepositoryGitFilterRefusal | undefined {
  if (!(error instanceof DaemonRpcError) || error.code !== repositoryGitFilterErrorCode) return undefined
  const data = repositoryGitFilterRefusalSchema.safeParse(error.data)
  return data.success ? data.data : undefined
}
