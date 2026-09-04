import { z } from "zod"

export const sessionTransferContractRefusalSchema = z.enum([
  "session-approval-pending",
  "session-transfer-in-progress",
  "session-not-owned",
  "session-base-commit-missing",
  "session-state-changed",
  "session-state-invalid",
  "session-resource-unavailable",
  "target-project-missing",
  "target-project-changed",
  "target-project-mismatch",
  "target-session-newer",
  "target-session-diverged",
  "target-lineage-check-unavailable",
  "target-bundle-restore-unavailable",
  "target-ref-restore-unavailable",
  "target-artifact-import-unavailable",
  "target-usage-import-unavailable",
  "target-state-persistence-unavailable",
])

export type SessionTransferContractRefusal = z.infer<
  typeof sessionTransferContractRefusalSchema
>

export const sessionTransferContractRefusalMessage: Record<
  SessionTransferContractRefusal,
  string
> = {
  "session-approval-pending": "Resolve the open approval before moving this session",
  "session-transfer-in-progress": "This session is already moving to another machine",
  "session-not-owned": "This machine no longer owns the session, so it cannot move it again",
  "session-base-commit-missing": "Create a checkpoint before moving this session",
  "session-state-changed": "The session changed after the transfer preview, so review the move again",
  "session-state-invalid": "The session state could not be packaged safely, so repair it before moving",
  "session-resource-unavailable": "A session resource could not be read, so the session cannot move yet",
  "target-project-missing": "Open the matching project on the target machine before moving this session",
  "target-project-changed": "The target switched projects after the transfer preview, so review the move again",
  "target-project-mismatch": "The target project does not share this session's Git history",
  "target-session-newer": "The target already has a newer generation of this session",
  "target-session-diverged": "The target has a different copy of this session and needs manual recovery",
  "target-lineage-check-unavailable": "The target cannot verify the project's Git history, so it cannot accept the session",
  "target-bundle-restore-unavailable": "The target cannot restore Git bundle transfers",
  "target-ref-restore-unavailable": "The target cannot restore Git ref transfers",
  "target-artifact-import-unavailable": "The target cannot restore the promoted artifact sources in this session",
  "target-usage-import-unavailable": "The target cannot restore this session's usage history",
  "target-state-persistence-unavailable": "The target cannot atomically persist transferred session ownership",
}
