import { worktreeFilePathSchema, type SessionEvidence, type ThreadItem } from "@getdomovoi/protocol"
import type { WorkspaceEvidence } from "./workspace.js"

export function fileEvidenceAssociations(
  workspace: WorkspaceEvidence,
  sessionId: string,
  items: readonly ThreadItem[],
): NonNullable<SessionEvidence["fileAssociations"]> {
  const targets = new Map(workspace.revertTargets?.map((target) => [target.path, target.kind]))
  let checkpointId: string | undefined
  for (const item of items) {
    if (item.kind === "checkpoint" && item.sessionId === sessionId && item.commit === workspace.baseCommit) {
      checkpointId = item.id
    }
  }
  return workspace.files.map((file) => {
    const kind = targets.get(file.path)
    return {
      path: file.path,
      // Canonical tool records have command text and status, but no file-access
      // telemetry. Neither a matching command nor zero runs proves coverage.
      tests: { state: "unknown", reason: "file-access-not-recorded" },
      revertTarget: !worktreeFilePathSchema.safeParse(file.path).success
        ? { kind: "unavailable", reason: "unsupported-path" }
        : kind === undefined
          ? { kind: "unavailable", reason: "target-not-observed" }
          : { kind, baseCommit: workspace.baseCommit, ...(checkpointId === undefined ? {} : { checkpointId }) },
    }
  })
}
