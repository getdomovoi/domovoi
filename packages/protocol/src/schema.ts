import { z } from "zod"

import { skillEnablementReviewsSchema } from "./skills.js"

export const protocolVersion = "0.1.0" as const

export const clientKindSchema = z.enum(["desktop", "web", "tablet", "phone", "cli"])
export const clientIdentityIdSchema = z.string().trim().min(1).max(128)
export const connectionIdSchema = z.string().uuid()
export const permissionModeSchema = z.enum(["ask", "plan", "build"])
export const sessionStateSchema = z.enum([
  "active",
  "waiting",
  "idle",
  "done",
  "failed",
  "archiving",
  "archived",
])
export const connectionKindSchema = z.enum(["local", "lan", "tailnet", "ssh", "relay", "wsl"])
export const approvalRiskSchema = z.enum(["normal", "hard-gate"])
export const approvalDecisionSchema = z.enum([
  "allow-once",
  "always-project",
  "deny",
  "deny-explain",
])
export const reasoningEffortSchema = z.string().trim().min(1)

export const runtimeSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoning: reasoningEffortSchema,
  permissionMode: permissionModeSchema,
  auto: z.boolean(),
}).superRefine((runtime, context) => {
  if (runtime.auto && runtime.permissionMode !== "build") {
    context.addIssue({
      code: "custom",
      message: "Automatic execution is only valid in Build mode",
      path: ["auto"],
    })
  }
})

export const providerModelSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  supportedReasoningEfforts: z.array(reasoningEffortSchema),
  defaultReasoningEffort: reasoningEffortSchema,
  isDefault: z.boolean(),
}).superRefine((model, context) => {
  if (
    model.supportedReasoningEfforts.length > 0
    && !model.supportedReasoningEfforts.includes(model.defaultReasoningEffort)
  ) {
    context.addIssue({
      code: "custom",
      path: ["defaultReasoningEffort"],
      message: "Default reasoning effort must be supported",
    })
  }
})
export const providerModelsSchema = z.array(providerModelSchema)

export const providerFailureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("authentication-expired"), action: z.literal("sign-in"), message: z.literal("Provider authentication expired"), retryable: z.literal(false) }),
  z.object({ kind: z.literal("rate-limit"), action: z.literal("retry"), message: z.literal("Provider rate limit reached"), retryable: z.literal(true) }),
  z.object({ kind: z.literal("quota-exhausted"), action: z.literal("check-quota"), message: z.literal("Provider quota is exhausted"), retryable: z.literal(false) }),
  z.object({ kind: z.literal("model-unavailable"), action: z.literal("change-model"), message: z.literal("Selected model is unavailable"), retryable: z.literal(false) }),
  z.object({ kind: z.literal("transport"), action: z.literal("retry"), message: z.literal("Provider connection failed"), retryable: z.literal(true) }),
  z.object({ kind: z.literal("unknown"), action: z.literal("retry"), message: z.literal("Provider request failed"), retryable: z.literal(true) }),
])

export const providerRuntimeStatusSchema = z.enum([
  "ready",
  "auth-required",
  "missing",
  "unknown",
])
export const providerRuntimeSchema = z.object({
  id: z.string().trim().min(1),
  command: z.string().trim().min(1),
  status: providerRuntimeStatusSchema,
  version: z.string().trim().min(1).optional(),
  sessionCapable: z.boolean().default(false),
})

export const machineSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  version: z.string().min(1),
  connection: connectionKindSchema,
  reachable: z.boolean(),
  providers: z.array(providerRuntimeSchema).default([]),
})

export const projectSchema = z.object({
  id: z.string().min(1),
  machineId: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
})

export const sessionForkOriginSchema = z.object({
  sourceSessionId: z.string().min(1),
  checkpointId: z.string().min(1),
  checkpointCommit: z.string().regex(/^[a-f0-9]{40}$/),
  requestId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  client: clientKindSchema,
  requestedRuntime: runtimeSchema,
})

export const sessionSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  state: sessionStateSchema,
  runtime: runtimeSchema,
  changedFiles: z.number().int().nonnegative(),
  testsPassed: z.number().int().nonnegative(),
  testsFailed: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  workspacePath: z.string().min(1).optional(),
  providerThreadId: z.string().min(1).optional(),
  activeTurnId: z.string().min(1).optional(),
  providerFailure: providerFailureSchema.optional(),
  baseCommit: z.string().min(1).optional(),
  archiveRequestedAt: z.string().datetime().optional(),
  archiveCheckpoint: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  archivedAt: z.string().datetime().optional(),
  forkedFrom: sessionForkOriginSchema.optional(),
}).superRefine((session, context) => {
  const archiveState = session.state === "archiving" || session.state === "archived"
  if (!archiveState && (
    session.archiveRequestedAt || session.archiveCheckpoint || session.archivedAt
  )) {
    context.addIssue({ code: "custom", path: ["state"], message: "Archive metadata requires an archive lifecycle state" })
  }
  if (archiveState && !session.archiveRequestedAt) {
    context.addIssue({ code: "custom", path: ["archiveRequestedAt"], message: "Archive lifecycle requires a request timestamp" })
  }
  if (session.state === "archiving" && session.archivedAt) {
    context.addIssue({ code: "custom", path: ["archivedAt"], message: "Archiving sessions cannot have a completion timestamp" })
  }
  if (session.state === "archived") {
    if (!session.archiveCheckpoint) {
      context.addIssue({ code: "custom", path: ["archiveCheckpoint"], message: "Archived sessions require a final checkpoint" })
    }
    if (!session.archivedAt) {
      context.addIssue({ code: "custom", path: ["archivedAt"], message: "Archived sessions require a completion timestamp" })
    }
    for (const field of ["workspacePath", "providerThreadId", "activeTurnId"] as const) {
      if (session[field]) context.addIssue({ code: "custom", path: [field], message: "Archived sessions cannot retain active resources" })
    }
  }
})

export const approvalRequestSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  risk: approvalRiskSchema,
  operation: z.string().min(1),
  command: z.string().min(1),
  machine: z.string().min(1),
  agent: z.string().min(1),
  mode: permissionModeSchema,
  directory: z.string().min(1),
  affects: z.string().min(1),
  network: z.string().min(1),
  estimatedDuration: z.string().min(1),
  checkpoint: z.string().min(1),
  providerRequestId: z.number().int().nonnegative().optional(),
  requestedAt: z.string().datetime(),
})

export const approvalRuleSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  operation: z.string().min(1),
  command: z.string().min(1),
  createdBy: clientKindSchema,
  createdByConnectionId: connectionIdSchema.optional(),
  createdByClientId: clientIdentityIdSchema.optional(),
  createdAt: z.string().datetime(),
})

export const threadItemSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    sessionId: z.string().min(1),
    kind: z.literal("checkpoint"),
    label: z.string(),
    commit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    createdAt: z.string().datetime(),
  }),
  z.object({
    id: z.string(),
    sessionId: z.string().min(1),
    kind: z.literal("user"),
    body: z.string(),
    createdAt: z.string().datetime(),
  }),
  z.object({
    id: z.string(),
    sessionId: z.string().min(1),
    kind: z.literal("system"),
    body: z.string(),
    detail: z.string().optional(),
    createdAt: z.string().datetime(),
  }),
  z.object({
    id: z.string(),
    sessionId: z.string().min(1),
    kind: z.literal("assistant"),
    body: z.string(),
    createdAt: z.string().datetime(),
  }),
  z.object({
    id: z.string(),
    sessionId: z.string().min(1),
    kind: z.literal("receipt"),
    decision: approvalDecisionSchema,
    operation: z.string(),
    checkpoint: z.string(),
    client: clientKindSchema,
    connectionId: connectionIdSchema.optional(),
    clientId: clientIdentityIdSchema.optional(),
    explanation: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
  }),
  z.object({
    id: z.string(),
    sessionId: z.string().min(1),
    kind: z.literal("tool"),
    tool: z.enum(["command", "file-change"]),
    status: z.enum(["running", "completed", "failed", "declined"]),
    title: z.string(),
    output: z.string().optional(),
    createdAt: z.string().datetime(),
  }),
])

export const artifactVariantSchema = z.object({
  id: z.string().min(1).max(128),
  groupId: z.string().min(1).max(256),
  label: z.string().min(1).max(120),
  order: z.number().int().min(0).max(1_023),
  thumbnail: z.object({
    path: z.string().min(1).max(1_024).refine((path) => {
      if (path.startsWith("/") || path.includes("\\") || path.includes("?") || path.includes("#")) return false
      if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false
      const segments = path.split("/")
      return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
    }, "Thumbnail must be a normalized relative file reference"),
    mimeType: z.enum(["image/png", "image/webp"]),
    revision: z.number().int().positive(),
  }).optional(),
})

export const artifactSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  title: z.string(),
  type: z.enum(["plan", "preview", "diff", "terminal"]),
  revision: z.number().int().positive(),
  path: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  content: z.string().optional(),
  variant: artifactVariantSchema.optional(),
})

export const annotationAnchorSchema = z.object({
  cssSelector: z.string().min(1).optional(),
  textQuote: z.string().min(1).optional(),
  bbox: z.object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
  }).optional(),
}).refine(
  (anchor) => Boolean(anchor.cssSelector || anchor.textQuote || anchor.bbox),
  { message: "An annotation anchor requires a selector, quote, or bounding box" },
)

export const annotationReplySchema = z.object({
  id: z.string().min(1),
  body: z.string().min(1),
  origin: clientKindSchema,
  createdAt: z.string().datetime(),
})

export const annotationVisualContextSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    ref: z.string().regex(/^crop-[a-f0-9]{64}$/),
    artifactRevision: z.number().int().positive(),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    byteLength: z.number().int().positive().max(1_500_000),
  }),
  z.object({
    status: z.literal("unavailable"),
    artifactRevision: z.number().int().positive(),
    reason: z.enum([
      "missing-bounds",
      "artifact-unavailable",
      "renderer-unavailable",
      "invalid-capture",
      "capture-failed",
    ]),
  }),
])

export const annotationSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  artifactId: z.string().min(1),
  variantId: z.string().min(1).optional(),
  anchor: annotationAnchorSchema,
  body: z.string().min(1),
  status: z.enum(["open", "resolved"]),
  statusChangedBy: clientKindSchema.optional(),
  statusChangedAt: z.string().datetime().optional(),
  origin: clientKindSchema,
  visualContext: annotationVisualContextSchema.optional(),
  thread: z.array(annotationReplySchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const workspaceSnapshotSchema = z.object({
  protocolVersion: z.literal(protocolVersion),
  machine: machineSchema,
  project: projectSchema.nullable(),
  sessions: z.array(sessionSummarySchema),
  activeSessionId: z.string().min(1).nullable(),
  approvals: z.array(approvalRequestSchema),
  approvalRules: z.array(approvalRuleSchema),
  thread: z.array(threadItemSchema),
  artifacts: z.array(artifactSchema),
  annotations: z.array(annotationSchema).default([]),
  skillEnablements: skillEnablementReviewsSchema.default([]),
  historyTruncated: z.boolean().optional(),
}).superRefine((snapshot, context) => {
  const aggregates = [
    ["sessions", snapshot.sessions],
    ["approvals", snapshot.approvals],
    ["approvalRules", snapshot.approvalRules],
    ["thread", snapshot.thread],
    ["artifacts", snapshot.artifacts],
    ["annotations", snapshot.annotations],
  ] as const
  for (const [field, records] of aggregates) {
    const ids = new Set<string>()
    records.forEach((record, index) => {
      if (ids.has(record.id)) {
        context.addIssue({
          code: "custom",
          message: `${field} IDs must be unique`,
          path: [field, index, "id"],
        })
      }
      ids.add(record.id)
    })
  }

  const skillReviewKeys = new Set<string>()
  snapshot.skillEnablements.forEach((review, index) => {
    const key = `${review.projectId}:${review.skillId}`
    if (skillReviewKeys.has(key)) {
      context.addIssue({
        code: "custom",
        message: "Skill enablement must be unique per project and skill",
        path: ["skillEnablements", index],
      })
    }
    skillReviewKeys.add(key)
  })

  snapshot.annotations.forEach((annotation, annotationIndex) => {
    const replyIds = new Set<string>()
    annotation.thread.forEach((reply, replyIndex) => {
      if (replyIds.has(reply.id)) {
        context.addIssue({
          code: "custom",
          message: "Annotation reply IDs must be unique within a thread",
          path: ["annotations", annotationIndex, "thread", replyIndex, "id"],
        })
      }
      replyIds.add(reply.id)
    })
  })

  if (snapshot.project === null) {
    const populatedFields = [
      snapshot.sessions,
      snapshot.approvals,
      snapshot.approvalRules,
      snapshot.thread,
      snapshot.artifacts,
      snapshot.annotations,
    ]
    if (snapshot.activeSessionId !== null || populatedFields.some((field) => field.length > 0)) {
      context.addIssue({
        code: "custom",
        message: "An unopened workspace cannot contain project state",
        path: ["project"],
      })
    }
    return
  }
  const project = snapshot.project

  if (project.machineId !== snapshot.machine.id) {
    context.addIssue({
      code: "custom",
      message: "Project must belong to the workspace machine",
      path: ["project", "machineId"],
    })
  }

  const sessionIds = new Set(snapshot.sessions.map((session) => session.id))
  const forkRequestIds = new Set<string>()
  snapshot.sessions.forEach((session, index) => {
    if (session.projectId !== project.id) {
      context.addIssue({
        code: "custom",
        message: "Session must belong to the workspace project",
        path: ["sessions", index, "projectId"],
      })
    }
    if (session.forkedFrom) {
      const origin = session.forkedFrom
      if (!sessionIds.has(origin.sourceSessionId) || origin.sourceSessionId === session.id) {
        context.addIssue({
          code: "custom",
          message: "Fork source must reference another existing session",
          path: ["sessions", index, "forkedFrom", "sourceSessionId"],
        })
      }
      const checkpoint = snapshot.thread.find((item) => item.id === origin.checkpointId)
      if (checkpoint && (
        checkpoint.kind !== "checkpoint"
        || checkpoint.sessionId !== origin.sourceSessionId
        || checkpoint.commit !== origin.checkpointCommit
      )) {
        context.addIssue({
          code: "custom",
          message: "Fork checkpoint must belong to the source session",
          path: ["sessions", index, "forkedFrom", "checkpointId"],
        })
      } else if (!checkpoint && !snapshot.historyTruncated) {
        context.addIssue({
          code: "custom",
          message: "Fork checkpoint must exist unless snapshot history is truncated",
          path: ["sessions", index, "forkedFrom", "checkpointId"],
        })
      }
      if (forkRequestIds.has(origin.requestId)) {
        context.addIssue({
          code: "custom",
          message: "Fork request IDs must be unique",
          path: ["sessions", index, "forkedFrom", "requestId"],
        })
      }
      forkRequestIds.add(origin.requestId)
    }
  })
  if (snapshot.activeSessionId !== null && !sessionIds.has(snapshot.activeSessionId)) {
    context.addIssue({
      code: "custom",
      message: "Active session must reference an existing session",
      path: ["activeSessionId"],
    })
  }
  snapshot.approvals.forEach((approval, index) => {
    if (!sessionIds.has(approval.sessionId)) {
      context.addIssue({
        code: "custom",
        message: "Approval must reference an existing session",
        path: ["approvals", index, "sessionId"],
      })
    }
  })
  snapshot.approvalRules.forEach((rule, index) => {
    if (rule.projectId !== project.id) {
      context.addIssue({
        code: "custom",
        message: "Approval rule must reference the workspace project",
        path: ["approvalRules", index, "projectId"],
      })
    }
  })
  snapshot.thread.forEach((item, index) => {
    if (!sessionIds.has(item.sessionId)) {
      context.addIssue({
        code: "custom",
        message: "Thread item must reference an existing session",
        path: ["thread", index, "sessionId"],
      })
    }
  })
  const artifactsById = new Map<string, Artifact>()
  snapshot.artifacts.forEach((artifact, index) => {
    if (!artifactsById.has(artifact.id)) artifactsById.set(artifact.id, artifact)
    if (!sessionIds.has(artifact.sessionId)) {
      context.addIssue({
        code: "custom",
        message: "Artifact must reference an existing session",
        path: ["artifacts", index, "sessionId"],
      })
    }
  })
  snapshot.annotations.forEach((annotation, index) => {
    if (!sessionIds.has(annotation.sessionId)) {
      context.addIssue({
        code: "custom",
        message: "Annotation must reference an existing session",
        path: ["annotations", index, "sessionId"],
      })
    }
    const artifact = artifactsById.get(annotation.artifactId)
    if (!artifact || artifact.sessionId !== annotation.sessionId) {
      context.addIssue({
        code: "custom",
        message: "Annotation artifact must belong to the same session",
        path: ["annotations", index, "artifactId"],
      })
    }
  })
})

export type ClientKind = z.infer<typeof clientKindSchema>
export type PermissionMode = z.infer<typeof permissionModeSchema>
export type ApprovalRisk = z.infer<typeof approvalRiskSchema>
export type Runtime = z.infer<typeof runtimeSchema>
export type Machine = z.infer<typeof machineSchema>
export type Project = z.infer<typeof projectSchema>
export type SessionSummary = z.infer<typeof sessionSummarySchema>
export type SessionForkOrigin = z.infer<typeof sessionForkOriginSchema>
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>
export type ApprovalRule = z.infer<typeof approvalRuleSchema>
export type ThreadItem = z.infer<typeof threadItemSchema>
export type Artifact = z.infer<typeof artifactSchema>
export type Annotation = z.infer<typeof annotationSchema>
export type ProviderModel = z.infer<typeof providerModelSchema>
export type ProviderFailure = z.infer<typeof providerFailureSchema>
export type ProviderRuntime = z.infer<typeof providerRuntimeSchema>
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>
