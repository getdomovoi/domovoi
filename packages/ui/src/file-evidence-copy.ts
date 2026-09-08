import type { FileRevertTarget, FileTestAssociation } from "@getdomovoi/protocol"

// The sheet's job here is to state what the daemon knows and refuse to imply
// more. Both of these read straight off the wire shape rather than inferring.

export function coverageLabel(tests: FileTestAssociation | undefined): string {
  // Absence is unknown, never none: an older daemon simply does not answer.
  if (!tests || tests.state === "unknown") return "Domovoi cannot tell which runs touched this file"
  if (tests.runIds.length === 0) return "No recorded run touched this file"
  const count = tests.runIds.length
  return `${count} recorded ${count === 1 ? "run" : "runs"} touched this file`
}

export function coverageIsKnown(tests: FileTestAssociation | undefined): boolean {
  return tests?.state === "known"
}

export type RevertPrompt =
  | { available: false, reason: string }
  | { available: true, verb: "Restore" | "Remove" | "Revert", confirmation: string, expectedBaseCommit?: string }

// The design assumes a checkpoint id every time. There is no per-file
// checkpoint history, so the confirmation names the commit unless a retained
// record for that exact commit exists.
export function revertPrompt(path: string, target: FileRevertTarget | undefined): RevertPrompt {
  // A daemon that reports no association at all is one that predates the
  // contract, not one refusing the revert. Legacy revert still works there, so
  // the control stays, with the generic wording and no commit guard.
  if (!target) {
    return {
      available: true,
      // The generic verb, because without a target this cannot say whether the
      // file will come back or go away.
      verb: "Revert",
      confirmation: `Revert ${path} to the session base commit? Only this file changes.`,
    }
  }
  if (target.kind === "unavailable") {
    return {
      available: false,
      reason: target.reason === "unsupported-path"
        ? "This path cannot be reverted one file at a time."
        : "Domovoi did not observe a version of this file to go back to.",
    }
  }
  const source = target.checkpointId
    ? `checkpoint ${target.checkpointId}`
    : `commit ${target.baseCommit.slice(0, 7)}`
  // A file absent from the base commit has no version to restore, so the honest
  // verb is remove. Saying "revert to the version in ..." would be a lie.
  const confirmation = target.kind === "restore"
    ? `Restore ${path} to the version in ${source}? Only this file changes. The worktree changes underneath the agent, which does not learn of it until its next read.`
    : `Remove ${path}? It does not exist in ${source}, so there is no earlier version to restore. Only this file changes, and the agent does not learn of it until its next read.`
  return {
    available: true,
    verb: target.kind === "restore" ? "Restore" : "Remove",
    confirmation,
    expectedBaseCommit: target.baseCommit,
  }
}
