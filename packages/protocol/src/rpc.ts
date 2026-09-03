import { z } from "zod"

import {
  transferBeginParamsSchema,
  transferBeginResultSchema,
  transferChunkParamsSchema,
  transferChunkResultSchema,
  transferHaveParamsSchema,
  transferHaveResultSchema,
} from "./transfer-rpc.js"
import {
  sessionTransferParamsSchema,
  sessionTransferResultSchema,
  transferFromRefParamsSchema,
  transferFromRefResultSchema,
} from "./transfer-request.js"

import {
  maximumSessionHistoryPageItems,
  maximumTerminalOutputChunkCharacters,
} from "./performance.js"

import {
  annotationAnchorSchema,
  approvalDecisionSchema,
  clientIdentityIdSchema,
  clientKindSchema,
  connectionIdSchema,
  providerModelsSchema,
  runtimeSchema,
  sessionStateSchema,
  workspaceSnapshotSchema,
} from "./schema.js"
import {
  deviceClaimParamsSchema,
  deviceIssueCodeResultSchema,
  deviceMachineCredentialParamsSchema,
  deviceMachineCredentialResultSchema,
  deviceSaveCredentialParamsSchema,
  deviceSaveCredentialResultSchema,
  deviceListParamsSchema,
  devicePairParamsSchema,
  devicePairResultSchema,
  deviceRevokeParamsSchema,
  deviceRotateParamsSchema,
  devicesResultSchema,
  pairedDeviceSchema,
} from "./devices.js"
import { fleetSnapshotSchema } from "./fleet.js"
import {
  annotationStatusSchema,
  canonicalBase64DecodedByteLength,
  commitShaSchema,
  credentialSchema,
  forkRequestIdSchema,
  machineIdSchema,
  toolKindSchema,
  toolStatusSchema,
} from "./identifiers.js"
import { previewBridgeChannelSchema } from "./preview-bridge.js"
import {
  skillCapabilityManifestSchema,
  skillContentDigestSchema,
  skillDocumentSchema,
  skillIdSchema,
  skillInventorySchema,
  skillSummariesSchema,
} from "./skills.js"

export const requestIdSchema = z.union([
  z.string().min(1).max(512),
  z.number().int().safe(),
])
export const daemonAuthenticationErrorCode = -32001 as const
export const daemonShuttingDownErrorCode = -32002 as const
export const machineCredentialMissingErrorCode = -32011 as const
export const projectSwitchConfirmationErrorCode = -32010 as const
export const protocolVersionMismatchErrorCode = -32012 as const
export const devicePairingLimitErrorCode = -32013 as const

const projectSwitchAffectedSessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  state: sessionStateSchema,
  workspacePath: z.string().min(1).optional(),
}).strict()

export const projectSwitchConfirmationSchema = z.object({
  kind: z.literal("project-switch-confirmation"),
  requestedPath: z.string().min(1),
  sessions: z.array(projectSwitchAffectedSessionSchema),
  sessionCount: z.number().int().nonnegative(),
  worktreeCount: z.number().int().nonnegative(),
}).strict().superRefine((confirmation, context) => {
  if (confirmation.sessionCount !== confirmation.sessions.length) {
    context.addIssue({
      code: "custom",
      message: "Session count must match the affected sessions",
      path: ["sessionCount"],
    })
  }
  const worktreeCount = confirmation.sessions.filter((session) => session.workspacePath).length
  if (confirmation.worktreeCount !== worktreeCount) {
    context.addIssue({
      code: "custom",
      message: "Worktree count must match affected session worktrees",
      path: ["worktreeCount"],
    })
  }
})

export type ProjectSwitchConfirmation = z.infer<typeof projectSwitchConfirmationSchema>

const rpcMethodNameSchema = z.string().min(1).refine(
  (method) => method.trim() === method,
  "Method names cannot start or end with whitespace",
)

export const maximumJsonValueDepth = 64

function jsonValueDepthWithinLimit(value: unknown, limit: number): boolean {
  const pending: Array<{ value: unknown, depth: number }> = [{ value, depth: 0 }]
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current.value === null || typeof current.value !== "object") continue
    if (current.depth >= limit) return false
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>)
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 })
  }
  return true
}

const jsonValueDepthGuard = z.unknown().superRefine((value, context) => {
  if (!jsonValueDepthWithinLimit(value, maximumJsonValueDepth)) {
    context.addIssue({
      code: "custom",
      message: `JSON values cannot nest deeper than ${maximumJsonValueDepth} levels`,
    })
  }
})

const jsonValueSchema = jsonValueDepthGuard.pipe(z.json())

const rpcParamsSchema = jsonValueDepthGuard.pipe(z.union([
  z.record(z.string(), z.json()),
  z.array(z.json()),
]))

export const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: requestIdSchema,
  method: rpcMethodNameSchema,
  params: rpcParamsSchema.optional(),
}).strict()

const rpcErrorSchema = z.object({
  code: z.number().int().safe(),
  message: z.string(),
  data: jsonValueSchema.optional(),
}).strict()

const rpcSuccessResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: requestIdSchema,
  result: jsonValueSchema,
  error: z.never().optional(),
}).strict()

const rpcErrorResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: requestIdSchema.nullable(),
  result: z.never().optional(),
  error: rpcErrorSchema,
}).strict()

export const rpcResponseSchema = z.union([
  rpcSuccessResponseSchema,
  rpcErrorResponseSchema,
])

export const rpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: rpcMethodNameSchema,
  params: rpcParamsSchema.optional(),
}).strict()

export const maximumWorkspaceDeltaChunkLength = 256 * 1_024
export const maximumWorkspaceDeltaOperations = 16
export const maximumSessionHistoryQueryLength = 256
export const maximumAuditQueryPageItems = 100
export const maximumAuditExportItems = 500
export const maximumAuditExportLength = 2_000_000
export const maximumSessionEvidenceDiffLength = 256 * 1_024
export const maximumSessionEvidenceFiles = 200
export const maximumSessionEvidenceRuns = 50
export const maximumSessionEvidenceCommandLength = 4_096
export const maximumSessionEvidenceOutputLength = 4_096
export const maximumEmergencyStopFailures = 100
export const maximumEmergencyStopFailureMessageLength = 512

const streamedIdSchema = z.string().min(1).max(512)
const historyEntryIdSchema = z.string().min(1).max(1_024)
const streamedChunkSchema = z.string().min(1).max(maximumWorkspaceDeltaChunkLength)

export const workspaceDeltaOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("assistant.append"),
    id: streamedIdSchema,
    delta: streamedChunkSchema,
    createdAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("tool-output.append"),
    id: streamedIdSchema,
    delta: streamedChunkSchema,
    createdAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("plan.append"),
    id: streamedIdSchema,
    delta: streamedChunkSchema,
    revision: z.number().int().positive(),
  }),
])

export const workspaceDeltaSchema = z.object({
  sessionId: streamedIdSchema,
  updatedAt: z.string().datetime(),
  operations: z.array(workspaceDeltaOperationSchema).min(1).max(maximumWorkspaceDeltaOperations),
})

export const sessionHistoryCategorySchema = z.enum([
  "messages",
  "tools",
  "approvals",
  "handoffs",
  "checkpoints",
  "annotations",
  "tests",
])

const historyEntryBase = {
  id: historyEntryIdSchema,
  sourceId: streamedIdSchema,
  sessionId: streamedIdSchema,
  createdAt: z.string().datetime(),
}

const historyToolFields = {
  tool: toolKindSchema,
  status: toolStatusSchema,
  title: z.string(),
  output: z.string().optional(),
}

export const sessionHistoryEntrySchema = z.discriminatedUnion("category", [
  z.object({
    ...historyEntryBase,
    category: z.literal("messages"),
    role: z.enum(["user", "assistant", "system"]),
    body: z.string(),
    detail: z.string().optional(),
  }),
  z.object({
    ...historyEntryBase,
    category: z.literal("tools"),
    ...historyToolFields,
  }),
  z.object({
    ...historyEntryBase,
    category: z.literal("approvals"),
    decision: approvalDecisionSchema,
    operation: z.string(),
    checkpoint: z.string(),
    client: clientKindSchema,
    connectionId: connectionIdSchema.optional(),
    clientId: clientIdentityIdSchema.optional(),
    explanation: z.string().min(1).optional(),
  }),
  z.object({
    ...historyEntryBase,
    category: z.literal("handoffs"),
    body: z.string(),
    detail: z.string().optional(),
  }),
  z.object({
    ...historyEntryBase,
    category: z.literal("checkpoints"),
    label: z.string(),
    commit: commitShaSchema.optional(),
  }),
  z.object({
    ...historyEntryBase,
    category: z.literal("annotations"),
    annotationId: streamedIdSchema,
    action: z.enum(["created", "reply"]),
    body: z.string(),
    origin: clientKindSchema,
    artifactId: streamedIdSchema.optional(),
    status: annotationStatusSchema.optional(),
  }),
  z.object({
    ...historyEntryBase,
    category: z.literal("tests"),
    ...historyToolFields,
  }),
])

export const sessionHistoryParamsSchema = z.object({
  sessionId: streamedIdSchema,
  before: historyEntryIdSchema.optional(),
  limit: z.number().int().min(1).max(maximumSessionHistoryPageItems).default(50),
  categories: z.array(sessionHistoryCategorySchema).min(1).max(
    sessionHistoryCategorySchema.options.length,
  ).refine(
    (categories) => new Set(categories).size === categories.length,
    "History categories must be unique",
  ).optional(),
  query: z.string().trim().min(1).max(maximumSessionHistoryQueryLength).optional(),
})

export const sessionHistoryPageSchema = z.object({
  sessionId: streamedIdSchema,
  items: z.array(sessionHistoryEntrySchema).max(maximumSessionHistoryPageItems),
  hasMore: z.boolean(),
  nextCursor: historyEntryIdSchema.optional(),
}).superRefine((page, context) => {
  const itemIds = new Set<string>()
  page.items.forEach((item, index) => {
    if (itemIds.has(item.id)) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "id"],
        message: "History item IDs must be unique within a page",
      })
    }
    itemIds.add(item.id)
    if (item.sessionId !== page.sessionId) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "sessionId"],
        message: "History items must belong to the requested session",
      })
    }
  })
  if (page.hasMore && !page.nextCursor) {
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "A continuation cursor is required when more history is available",
    })
  }
  if (
    page.hasMore
    && page.nextCursor !== undefined
    && page.nextCursor !== page.items[0]?.id
  ) {
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "The continuation cursor must reference the first history item",
    })
  }
  if (!page.hasMore && page.nextCursor !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "A continuation cursor is not allowed when history is complete",
    })
  }
})

const auditTextSchema = z.string().trim().min(1).max(512)
export const auditOutcomeSchema = z.enum([
  "started",
  "succeeded",
  "failed",
  "denied",
  "cancelled",
])
const auditActorReferenceSchema = z.string().trim().min(1).max(128)
export const auditActorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("client"),
    client: clientKindSchema,
    clientId: auditActorReferenceSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("provider"),
    provider: auditActorReferenceSchema,
    providerThreadId: auditActorReferenceSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("daemon"),
    component: auditActorReferenceSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("machine"),
    machineId: machineIdSchema,
  }).strict(),
])
export const auditEntrySchema = z.object({
  id: streamedIdSchema,
  occurredAt: z.string().datetime(),
  actor: auditActorSchema,
  action: auditTextSchema,
  outcome: auditOutcomeSchema,
  sessionId: streamedIdSchema.optional(),
  projectId: streamedIdSchema.optional(),
  target: auditTextSchema.optional(),
  detail: z.string().max(4_096).optional(),
}).strict()

const auditQueryFiltersSchema = z.object({
  query: auditTextSchema.optional(),
  action: auditTextSchema.optional(),
  actor: auditTextSchema.optional(),
  outcome: auditOutcomeSchema.optional(),
  sessionId: streamedIdSchema.optional(),
  projectId: streamedIdSchema.optional(),
  before: streamedIdSchema.optional(),
})

export const auditQueryParamsSchema = auditQueryFiltersSchema.extend({
  limit: z.number().int().min(1).max(maximumAuditQueryPageItems).default(50),
})

export const auditExportParamsSchema = auditQueryFiltersSchema.extend({
  format: z.literal("jsonl").default("jsonl"),
  limit: z.number().int().min(1).max(maximumAuditExportItems).default(maximumAuditExportItems),
})

function validateAuditCursorPage(
  page: {
    entries: Array<{ id: string }>
    hasMore: boolean
    nextCursor?: string | undefined
  },
  context: z.RefinementCtx,
): void {
  if (page.hasMore && page.entries.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["entries"],
      message: "A non-empty audit page is required when more entries are available",
    })
  } else if (page.hasMore && page.nextCursor !== page.entries.at(-1)?.id) {
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "The continuation cursor must reference the last returned audit entry",
    })
  }
  if (!page.hasMore && page.nextCursor !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "A continuation cursor is not allowed when the audit page is complete",
    })
  }
}

export const auditQueryPageSchema = z.object({
  entries: z.array(auditEntrySchema).max(maximumAuditQueryPageItems),
  hasMore: z.boolean(),
  nextCursor: streamedIdSchema.optional(),
}).superRefine(validateAuditCursorPage)

export const auditExportResultSchema = z.object({
  format: z.literal("jsonl"),
  exportedAt: z.string().datetime(),
  entryCount: z.number().int().min(0).max(maximumAuditExportItems),
  content: z.string().max(maximumAuditExportLength),
  hasMore: z.boolean(),
  nextCursor: streamedIdSchema.optional(),
}).superRefine((result, context) => {
  const lines = auditExportLines(result.content, context)
  if (lines.length !== result.entryCount) {
    context.addIssue({
      code: "custom",
      path: ["entryCount"],
      message: "Audit export entry count must match its JSONL content",
    })
  }
  lines.forEach((line, index) => {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      context.addIssue({
        code: "custom",
        path: ["content", index],
        message: "Audit export content must contain valid JSONL",
      })
      return
    }
    const parsed = auditEntrySchema.safeParse(value)
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        path: ["content", index],
        message: "Audit export lines must match the audit entry schema",
      })
    }
  })
  if (result.hasMore && !result.nextCursor) {
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "A continuation cursor is required when more audit entries are exportable",
    })
  }
  if (!result.hasMore && result.nextCursor !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message: "A continuation cursor is not allowed when the audit export is complete",
    })
  }
})

function auditExportLines(content: string, context: z.RefinementCtx): string[] {
  if (content.length === 0) return []
  if (!content.endsWith("\n")) {
    context.addIssue({
      code: "custom",
      path: ["content"],
      message: "Audit JSONL exports must end with a newline",
    })
    return content.split("\n")
  }
  return content.slice(0, -1).split("\n")
}
export const changedFileEvidenceSchema = z.object({
  path: z.string().min(1).max(4_096),
  previousPath: z.string().min(1).max(4_096).optional(),
  status: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "untracked",
    "conflicted",
  ]),
  staged: z.boolean(),
  unstaged: z.boolean(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
}).strict().superRefine((file, context) => {
  if (file.previousPath !== undefined && file.status !== "renamed" && file.status !== "copied") {
    context.addIssue({
      code: "custom",
      path: ["previousPath"],
      message: "Only renamed or copied files may include a previous path",
    })
  }
  if (file.binary && (file.additions !== null || file.deletions !== null)) {
    context.addIssue({
      code: "custom",
      path: ["binary"],
      message: "Binary files cannot report line counts",
    })
  }
})

export const workspaceEvidenceSchema = z.object({
  baseCommit: commitShaSchema,
  diff: z.string().max(maximumSessionEvidenceDiffLength),
  diffTruncated: z.boolean(),
  totalChangedFiles: z.number().int().nonnegative(),
  files: z.array(changedFileEvidenceSchema).max(maximumSessionEvidenceFiles),
  filesTruncated: z.boolean(),
}).strict().superRefine((workspace, context) => {
  const paths = new Set<string>()
  workspace.files.forEach((file, index) => {
    if (paths.has(file.path)) {
      context.addIssue({
        code: "custom",
        path: ["files", index, "path"],
        message: "Changed-file paths must be unique",
      })
    }
    paths.add(file.path)
  })
  const expected = workspace.files.length
  if (
    (!workspace.filesTruncated && workspace.totalChangedFiles !== expected)
    || (workspace.filesTruncated && workspace.totalChangedFiles <= expected)
  ) {
    context.addIssue({
      code: "custom",
      path: ["totalChangedFiles"],
      message: "Changed-file total must describe the bounded file list",
    })
  }
})

export const testRunEvidenceSchema = z.object({
  id: streamedIdSchema,
  command: z.string().min(1).max(maximumSessionEvidenceCommandLength),
  commandTruncated: z.boolean(),
  status: z.enum(["passed", "failed"]),
  output: z.string().max(maximumSessionEvidenceOutputLength).optional(),
  outputTruncated: z.boolean(),
  createdAt: z.string().datetime(),
}).strict()

export const testEvidenceSchema = z.object({
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  totalRuns: z.number().int().nonnegative(),
  runs: z.array(testRunEvidenceSchema).max(maximumSessionEvidenceRuns),
  runsTruncated: z.boolean(),
}).strict().superRefine((tests, context) => {
  const runIds = new Set<string>()
  tests.runs.forEach((run, index) => {
    if (runIds.has(run.id)) {
      context.addIssue({
        code: "custom",
        path: ["runs", index, "id"],
        message: "Observed command-run IDs must be unique",
      })
    }
    runIds.add(run.id)
  })
  if (tests.passed + tests.failed !== tests.totalRuns) {
    context.addIssue({
      code: "custom",
      path: ["totalRuns"],
      message: "Command-run totals must equal passed and failed runs",
    })
  }
  if (
    (!tests.runsTruncated && tests.totalRuns !== tests.runs.length)
    || (tests.runsTruncated && tests.totalRuns <= tests.runs.length)
  ) {
    context.addIssue({
      code: "custom",
      path: ["runs"],
      message: "Command-run total must describe the bounded run list",
    })
  }
  const visiblePassed = tests.runs.filter((run) => run.status === "passed").length
  const visibleFailed = tests.runs.length - visiblePassed
  if (visiblePassed > tests.passed || visibleFailed > tests.failed) {
    context.addIssue({
      code: "custom",
      path: ["runs"],
      message: "Visible command-run statuses cannot exceed aggregate counts",
    })
  }
  if (!tests.runsTruncated) {
    if (visiblePassed !== tests.passed || visibleFailed !== tests.failed) {
      context.addIssue({
        code: "custom",
        path: ["runs"],
        message: "Command-run statuses must match aggregate counts",
      })
    }
  }
})

export const sessionEvidenceSchema = z.object({
  sessionId: streamedIdSchema,
  refreshedAt: z.string().datetime(),
  workspace: workspaceEvidenceSchema,
  tests: testEvidenceSchema,
}).strict()

// The protocol version every client spoke before the handshake carried one.
// It is a fixed historical fact, not the daemon's current version, so a
// versionless client stays correctly classified once this daemon moves on.
export const versionlessClientProtocol = "0.1.0" as const

const protocolVersionPatternSchema = z.string().regex(/^\d+\.\d+\.\d+$/, "Protocol version must be a three-part semver")

const clientHelloParamsSchema = z.object({
  client: clientKindSchema,
  clientId: clientIdentityIdSchema.optional(),
  clientVersion: z.string().min(1).max(64),
  protocolVersion: protocolVersionPatternSchema.optional(),
  authToken: z.string().min(1).optional(),
}).strict()

const machineHelloParamsSchema = z.object({
  client: z.literal("machine"),
  machineId: machineIdSchema,
  clientVersion: z.string().min(1).max(64),
  protocolVersion: protocolVersionPatternSchema.optional(),
  authToken: z.string().min(1).optional(),
}).strict()

export const helloParamsSchema = z.discriminatedUnion("client", [
  clientHelloParamsSchema,
  machineHelloParamsSchema,
])

export const systemHelloResultSchema = workspaceSnapshotSchema.extend({
  connectionId: connectionIdSchema.optional(),
})

export const artifactAccessPurposeSchema = z.enum(["preview", "print", "download"])

export const artifactAuthorizeParamsSchema = z.object({
  sessionId: z.string().min(1),
  artifactId: z.string().min(1),
  revision: z.number().int().positive(),
  purpose: artifactAccessPurposeSchema,
  bridgeChannel: previewBridgeChannelSchema.optional(),
  client: clientKindSchema,
}).strict().superRefine((value, context) => {
  if (value.bridgeChannel && value.purpose !== "preview") {
    context.addIssue({ code: "custom", path: ["bridgeChannel"], message: "Only preview access may use the bridge" })
  }
})

export const artifactAuthorizeResultSchema = z.object({
  sessionId: z.string().min(1),
  artifactId: z.string().min(1),
  revision: z.number().int().positive(),
  purpose: artifactAccessPurposeSchema,
  bridgeChannel: previewBridgeChannelSchema.optional(),
  expiresAt: z.number().int().positive(),
  signature: credentialSchema,
}).strict()

const terminalIdSchema = z.string().min(1).max(128)
const terminalDimensionSchema = z.number().int().min(2).max(1_000)

export const terminalOwnerSchema = z.object({
  client: clientKindSchema,
  clientId: clientIdentityIdSchema,
})

const terminalClientIdentitySchema = terminalOwnerSchema

export const terminalCreateParamsSchema = z.object({
  terminalId: terminalIdSchema,
  sessionId: z.string().min(1),
  cols: terminalDimensionSchema,
  rows: terminalDimensionSchema,
}).extend(terminalClientIdentitySchema.shape)

export const terminalInputParamsSchema = z.object({
  terminalId: terminalIdSchema,
  data: z.string().min(1).max(65_536),
}).extend(terminalClientIdentitySchema.shape)

export const terminalResizeParamsSchema = z.object({
  terminalId: terminalIdSchema,
  cols: terminalDimensionSchema,
  rows: terminalDimensionSchema,
}).extend(terminalClientIdentitySchema.shape)

export const terminalCloseParamsSchema = z.object({
  terminalId: terminalIdSchema,
}).extend(terminalClientIdentitySchema.shape)

export const terminalClaimParamsSchema = z.object({
  terminalId: terminalIdSchema,
}).extend(terminalClientIdentitySchema.shape)

export const terminalSessionSchema = z.object({
  terminalId: terminalIdSchema,
  sessionId: z.string().min(1),
  cols: terminalDimensionSchema,
  rows: terminalDimensionSchema,
  shell: z.string().min(1),
  cwd: z.string().min(1),
  buffer: z.string(),
  owner: terminalOwnerSchema,
})

export const terminalAcceptedSchema = z.object({ accepted: z.literal(true) })
export const terminalOutputNotificationSchema = z.object({
  terminalId: terminalIdSchema,
  data: z.string().min(1).max(maximumTerminalOutputChunkCharacters),
})
export const terminalClosedNotificationSchema = z.object({
  terminalId: terminalIdSchema,
  exitCode: z.number().int().optional(),
  signal: z.number().int().optional(),
})
export const terminalOwnershipNotificationSchema = z.object({
  terminalId: terminalIdSchema,
  owner: terminalOwnerSchema,
})

export const systemPauseAllParamsSchema = z.object({
  client: clientKindSchema,
})

export const fleetListParamsSchema = z.object({}).strict()

export const systemEmergencyStopParamsSchema = z.object({
  client: clientKindSchema,
}).strict()

const emergencyStopCountSchema = z.number().int().nonnegative().safe()

export const emergencyStopOutcomesSchema = z.object({
  turnsStopped: emergencyStopCountSchema,
  terminalsClosed: emergencyStopCountSchema,
  approvalsDenied: emergencyStopCountSchema,
  mutationsCancelled: emergencyStopCountSchema,
  providersReset: emergencyStopCountSchema,
}).strict()

export const emergencyStopFailureSchema = z.object({
  target: z.enum([
    "turn",
    "terminal",
    "approval",
    "provider",
    "mutation",
    "persistence",
  ]),
  targetId: z.string().trim().min(1).max(512).optional(),
  message: z.string().trim().min(1).max(maximumEmergencyStopFailureMessageLength),
}).strict()

export const systemEmergencyStopResultSchema = z.object({
  snapshot: workspaceSnapshotSchema,
  stopId: z.string().trim().min(1).max(128),
  requestedAt: z.string().datetime(),
  client: clientKindSchema,
  outcomes: emergencyStopOutcomesSchema,
  failures: z.array(emergencyStopFailureSchema).max(maximumEmergencyStopFailures),
}).strict()

export const systemEmergencyStoppedNotificationSchema = systemEmergencyStopResultSchema

export const maximumSessionPromptCharacters = 262_144

export const approvalResolveParamsSchema = z
  .object({
    approvalId: z.string().min(1),
    decision: approvalDecisionSchema,
    explanation: z.string().trim().min(1).max(4_096).optional(),
  })
  .superRefine((params, context) => {
    if (params.decision === "deny-explain" && !params.explanation) {
      context.addIssue({
        code: "custom",
        message: "An explanation is required for deny-explain",
        path: ["explanation"],
      })
    }
  })

export const sessionSetRuntimeParamsSchema = z.object({
  sessionId: z.string().min(1),
  runtime: runtimeSchema,
  client: clientKindSchema,
})

export const sessionRestartProviderThreadParamsSchema = z.object({
  sessionId: z.string().min(1),
  runtime: runtimeSchema.optional(),
  client: clientKindSchema,
}).strict()

export const runtimeModelsParamsSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  client: clientKindSchema,
})

export const projectOpenParamsSchema = z.object({
  path: z.string().min(1).max(4_096),
  client: clientKindSchema,
  confirmation: projectSwitchConfirmationSchema.optional(),
}).strict()

export const sessionCreateParamsSchema = z.object({
  title: z.string().trim().min(1).max(512),
  runtime: runtimeSchema,
  client: clientKindSchema,
})

export const sessionForkParamsSchema = z.object({
  sessionId: z.string().min(1),
  checkpointId: z.string().min(1),
  requestId: forkRequestIdSchema,
  runtime: runtimeSchema,
  client: clientKindSchema,
})

export const sessionActivateParamsSchema = z.object({
  sessionId: z.string().min(1),
  client: clientKindSchema,
})

export const sessionPauseParamsSchema = z.object({
  sessionId: z.string().min(1),
  client: clientKindSchema,
})

export const sessionEvidenceParamsSchema = z.object({
  sessionId: streamedIdSchema,
})

export const sessionArchiveParamsSchema = z.object({
  sessionId: z.string().min(1),
  client: clientKindSchema,
})

export const sessionSendParamsSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string().trim().min(1).max(maximumSessionPromptCharacters),
  client: clientKindSchema,
})

export const checkpointCreateParamsSchema = z.object({
  sessionId: z.string().min(1),
  label: z.string().trim().min(1).max(512).optional(),
  client: clientKindSchema,
})

export const checkpointRestoreParamsSchema = z.object({
  sessionId: z.string().min(1),
  checkpointId: z.string().min(1),
  client: clientKindSchema,
})

export { canonicalBase64DecodedByteLength } from "./identifiers.js"

export const annotationCreateParamsSchema = z.object({
  sessionId: z.string().min(1),
  artifactId: z.string().min(1),
  variantId: z.string().min(1).optional(),
  anchor: annotationAnchorSchema,
  body: z.string().trim().min(1).max(8_192),
  visualContextUpload: z.object({
    artifactRevision: z.number().int().positive(),
    mimeType: z.literal("image/png"),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    data: z.string().min(4).max(2_000_000).refine(
      (value) => {
        const decodedBytes = canonicalBase64DecodedByteLength(value)
        return decodedBytes !== undefined && decodedBytes <= 1_500_000
      },
      { message: "Visual context data must be canonical bounded Base64" },
    ),
  }).optional(),
  client: clientKindSchema,
})

export const annotationReplyParamsSchema = z.object({
  annotationId: z.string().min(1),
  body: z.string().trim().min(1).max(8_192),
  client: clientKindSchema,
})

export const annotationSetStatusParamsSchema = z.object({
  annotationId: z.string().min(1),
  status: annotationStatusSchema,
  client: clientKindSchema,
})

export const directApiProviderSchema = z.enum(["anthropic", "openai", "openrouter"])
export const providerSecretStatusSchema = z.object({
  provider: directApiProviderSchema,
  state: z.enum(["stored", "not-set", "unavailable"]),
  source: z.literal("keychain"),
}).strict()
export const providerSecretStatusesSchema = z.array(providerSecretStatusSchema)
const usageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative(),
  currency: z.string().length(3).optional(),
}).strict()
export const sessionUsageSchema = usageTotalsSchema.extend({
  sessionId: z.string().min(1),
  reportedCostTurns: z.number().int().nonnegative(),
  unavailableCostTurns: z.number().int().nonnegative(),
  byRuntime: z.array(usageTotalsSchema.extend({
    provider: z.string().min(1),
    model: z.string().min(1),
    turns: z.number().int().nonnegative(),
  }).strict()),
}).strict()

export const rpcMethods = {
  "system.hello": { params: helloParamsSchema, result: systemHelloResultSchema },
  "artifact.authorize": {
    params: artifactAuthorizeParamsSchema,
    result: artifactAuthorizeResultSchema,
  },
  "terminal.create": { params: terminalCreateParamsSchema, result: terminalSessionSchema },
  "terminal.claim": {
    params: terminalClaimParamsSchema,
    result: terminalOwnershipNotificationSchema,
  },
  "terminal.input": { params: terminalInputParamsSchema, result: terminalAcceptedSchema },
  "terminal.resize": { params: terminalResizeParamsSchema, result: terminalAcceptedSchema },
  "terminal.close": { params: terminalCloseParamsSchema, result: terminalAcceptedSchema },
  "fleet.list": { params: fleetListParamsSchema, result: fleetSnapshotSchema },
  "device.pair": { params: devicePairParamsSchema, result: devicePairResultSchema },
  // Reachable before authentication: a machine being paired has no credential
  // yet. Gated on an open pairing code and nothing else.
  "device.claim": { params: deviceClaimParamsSchema, result: devicePairResultSchema },
  "device.issueCode": { params: deviceListParamsSchema, result: deviceIssueCodeResultSchema },
  "device.saveCredential": {
    params: deviceSaveCredentialParamsSchema,
    result: deviceSaveCredentialResultSchema,
  },
  "session.transfer": {
    params: sessionTransferParamsSchema,
    result: sessionTransferResultSchema,
  },
  "transfer.fromRef": {
    params: transferFromRefParamsSchema,
    result: transferFromRefResultSchema,
  },
  "transfer.have": {
    params: transferHaveParamsSchema,
    result: transferHaveResultSchema,
  },
  "transfer.begin": {
    params: transferBeginParamsSchema,
    result: transferBeginResultSchema,
  },
  "transfer.chunk": {
    params: transferChunkParamsSchema,
    result: transferChunkResultSchema,
  },
  "device.machineCredential": {
    params: deviceMachineCredentialParamsSchema,
    result: deviceMachineCredentialResultSchema,
  },
  "device.list": { params: deviceListParamsSchema, result: devicesResultSchema },
  "device.revoke": {
    params: deviceRevokeParamsSchema,
    result: z.object({ device: pairedDeviceSchema }).strict(),
  },
  "device.rotate": {
    params: deviceRotateParamsSchema,
    result: devicePairResultSchema,
  },
  "system.pauseAll": {
    params: systemPauseAllParamsSchema,
    result: workspaceSnapshotSchema,
  },
  "system.emergencyStop": {
    params: systemEmergencyStopParamsSchema,
    result: systemEmergencyStopResultSchema,
  },
  "workspace.get": { params: z.object({}).strict(), result: workspaceSnapshotSchema },
  "session.evidence": { params: sessionEvidenceParamsSchema, result: sessionEvidenceSchema },
  "session.history": { params: sessionHistoryParamsSchema, result: sessionHistoryPageSchema },
  "audit.query": { params: auditQueryParamsSchema, result: auditQueryPageSchema },
  "audit.export": { params: auditExportParamsSchema, result: auditExportResultSchema },
  "skill.list": { params: z.object({}).strict(), result: skillSummariesSchema },
  "skill.inventory": { params: z.object({}).strict(), result: skillInventorySchema },
  "skill.read": {
    params: z.object({ id: skillIdSchema }),
    result: skillDocumentSchema,
  },
  "skill.setEnabled": {
    params: z.object({
      id: skillIdSchema,
      enabled: z.boolean(),
      contentDigest: skillContentDigestSchema,
      manifest: skillCapabilityManifestSchema,
    }).strict(),
    result: workspaceSnapshotSchema,
  },
  "runtime.models": {
    params: runtimeModelsParamsSchema,
    result: providerModelsSchema,
  },
  "provider.refresh": {
    params: z.object({ client: clientKindSchema }).strict(),
    result: workspaceSnapshotSchema,
  },
  "provider.secret.list": {
    params: z.object({}).strict(),
    result: providerSecretStatusesSchema,
  },
  "session.usage": {
    params: z.object({ sessionId: z.string().min(1) }).strict(),
    result: sessionUsageSchema,
  },
  "annotation.create": {
    params: annotationCreateParamsSchema,
    result: workspaceSnapshotSchema,
  },
  "annotation.reply": {
    params: annotationReplyParamsSchema,
    result: workspaceSnapshotSchema,
  },
  "annotation.setStatus": {
    params: annotationSetStatusParamsSchema,
    result: workspaceSnapshotSchema,
  },
  "approval.resolve": {
    params: approvalResolveParamsSchema,
    result: workspaceSnapshotSchema,
  },
  "session.setRuntime": {
    params: sessionSetRuntimeParamsSchema,
    result: workspaceSnapshotSchema,
  },
  "session.restartProviderThread": {
    params: sessionRestartProviderThreadParamsSchema,
    result: workspaceSnapshotSchema,
  },
  "project.open": { params: projectOpenParamsSchema, result: workspaceSnapshotSchema },
  "session.activate": { params: sessionActivateParamsSchema, result: workspaceSnapshotSchema },
  "session.pause": { params: sessionPauseParamsSchema, result: workspaceSnapshotSchema },
  "session.archive": { params: sessionArchiveParamsSchema, result: workspaceSnapshotSchema },
  "session.create": { params: sessionCreateParamsSchema, result: workspaceSnapshotSchema },
  "session.fork": { params: sessionForkParamsSchema, result: workspaceSnapshotSchema },
  "session.send": { params: sessionSendParamsSchema, result: workspaceSnapshotSchema },
  "checkpoint.create": {
    params: checkpointCreateParamsSchema,
    result: workspaceSnapshotSchema,
  },
  "checkpoint.restore": {
    params: checkpointRestoreParamsSchema,
    result: workspaceSnapshotSchema,
  },
} as const

export type RpcMethod = keyof typeof rpcMethods
export type RpcParams<M extends RpcMethod> = z.infer<(typeof rpcMethods)[M]["params"]>
export type RpcResult<M extends RpcMethod> = z.infer<(typeof rpcMethods)[M]["result"]>
export type RpcRequest = z.infer<typeof rpcRequestSchema>
export type RpcResponse = z.infer<typeof rpcResponseSchema>
export type RpcNotification = z.infer<typeof rpcNotificationSchema>
export type ArtifactAccess = z.infer<typeof artifactAuthorizeResultSchema>
export type ArtifactAccessPurpose = z.infer<typeof artifactAccessPurposeSchema>
export type TerminalSession = z.infer<typeof terminalSessionSchema>
export type TerminalOwner = z.infer<typeof terminalOwnerSchema>
export type TerminalOutputNotification = z.infer<typeof terminalOutputNotificationSchema>
export type TerminalClosedNotification = z.infer<typeof terminalClosedNotificationSchema>
export type TerminalOwnershipNotification = z.infer<typeof terminalOwnershipNotificationSchema>
export type EmergencyStopOutcomes = z.infer<typeof emergencyStopOutcomesSchema>
export type EmergencyStopFailure = z.infer<typeof emergencyStopFailureSchema>
export type SystemEmergencyStopResult = z.infer<typeof systemEmergencyStopResultSchema>
export type SystemEmergencyStoppedNotification = z.infer<
  typeof systemEmergencyStoppedNotificationSchema
>
export type WorkspaceDelta = z.infer<typeof workspaceDeltaSchema>
export type SessionHistoryCategory = z.infer<typeof sessionHistoryCategorySchema>
export type SessionHistoryEntry = z.infer<typeof sessionHistoryEntrySchema>
export type SessionHistoryPage = z.infer<typeof sessionHistoryPageSchema>
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>
export type AuditActor = z.infer<typeof auditActorSchema>
export type AuditEntry = z.infer<typeof auditEntrySchema>
export type AuditQueryParams = z.infer<typeof auditQueryParamsSchema>
export type AuditQueryPage = z.infer<typeof auditQueryPageSchema>
export type AuditExportParams = z.infer<typeof auditExportParamsSchema>
export type AuditExportResult = z.infer<typeof auditExportResultSchema>
export type SessionUsage = z.infer<typeof sessionUsageSchema>
export type SessionEvidence = z.infer<typeof sessionEvidenceSchema>
export type ChangedFileEvidence = z.infer<typeof changedFileEvidenceSchema>
export type TestRunEvidence = z.infer<typeof testRunEvidenceSchema>
