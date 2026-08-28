import { z } from "zod"

import {
  annotationAnchorSchema,
  approvalDecisionSchema,
  clientKindSchema,
  providerModelsSchema,
  runtimeSchema,
  workspaceSnapshotSchema,
} from "./schema.js"
import { previewBridgeChannelSchema } from "./preview-bridge.js"
import { skillDocumentSchema, skillIdSchema, skillSummariesSchema } from "./skills.js"

export const requestIdSchema = z.union([z.string(), z.number()])
export const daemonAuthenticationErrorCode = -32001 as const

export const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: requestIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
})

export const rpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: requestIdSchema,
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number().int(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
})

export const rpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional(),
})

export const helloParamsSchema = z.object({
  client: clientKindSchema,
  clientVersion: z.string().min(1),
  authToken: z.string().min(1).optional(),
})

export const artifactAuthorizeParamsSchema = z.object({
  artifactId: z.string().min(1),
  bridgeChannel: previewBridgeChannelSchema.optional(),
  client: clientKindSchema,
})

export const artifactAuthorizeResultSchema = z.object({
  artifactId: z.string().min(1),
  bridgeChannel: previewBridgeChannelSchema.optional(),
  expiresAt: z.number().int().positive(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

const terminalIdSchema = z.string().min(1).max(128)
const terminalDimensionSchema = z.number().int().min(2).max(1_000)
const terminalClientIdSchema = z.string().min(8).max(128)

export const terminalOwnerSchema = z.object({
  client: clientKindSchema,
  clientId: terminalClientIdSchema,
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
  data: z.string().min(1),
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

export const approvalResolveParamsSchema = z
  .object({
    approvalId: z.string().min(1),
    decision: approvalDecisionSchema,
    client: clientKindSchema,
    explanation: z.string().trim().min(1).optional(),
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

export const runtimeModelsParamsSchema = z.object({
  provider: z.string().trim().min(1),
  client: clientKindSchema,
})

export const projectOpenParamsSchema = z.object({
  path: z.string().min(1),
  client: clientKindSchema,
})

export const sessionCreateParamsSchema = z.object({
  title: z.string().trim().min(1),
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

export const sessionSendParamsSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string().trim().min(1),
  client: clientKindSchema,
})

export const checkpointCreateParamsSchema = z.object({
  sessionId: z.string().min(1),
  label: z.string().trim().min(1).optional(),
  client: clientKindSchema,
})

export const annotationCreateParamsSchema = z.object({
  sessionId: z.string().min(1),
  artifactId: z.string().min(1),
  variantId: z.string().min(1).optional(),
  anchor: annotationAnchorSchema,
  body: z.string().trim().min(1),
  client: clientKindSchema,
})

export const annotationReplyParamsSchema = z.object({
  annotationId: z.string().min(1),
  body: z.string().trim().min(1),
  client: clientKindSchema,
})

export const annotationSetStatusParamsSchema = z.object({
  annotationId: z.string().min(1),
  status: z.enum(["open", "resolved"]),
  client: clientKindSchema,
})

export const rpcMethods = {
  "system.hello": { params: helloParamsSchema, result: workspaceSnapshotSchema },
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
  "system.pauseAll": {
    params: systemPauseAllParamsSchema,
    result: workspaceSnapshotSchema,
  },
  "workspace.get": { params: z.object({}), result: workspaceSnapshotSchema },
  "skill.list": { params: z.object({}), result: skillSummariesSchema },
  "skill.read": {
    params: z.object({ id: skillIdSchema }),
    result: skillDocumentSchema,
  },
  "runtime.models": {
    params: runtimeModelsParamsSchema,
    result: providerModelsSchema,
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
  "project.open": { params: projectOpenParamsSchema, result: workspaceSnapshotSchema },
  "session.activate": { params: sessionActivateParamsSchema, result: workspaceSnapshotSchema },
  "session.pause": { params: sessionPauseParamsSchema, result: workspaceSnapshotSchema },
  "session.create": { params: sessionCreateParamsSchema, result: workspaceSnapshotSchema },
  "session.send": { params: sessionSendParamsSchema, result: workspaceSnapshotSchema },
  "checkpoint.create": {
    params: checkpointCreateParamsSchema,
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
export type TerminalSession = z.infer<typeof terminalSessionSchema>
export type TerminalOwner = z.infer<typeof terminalOwnerSchema>
export type TerminalOutputNotification = z.infer<typeof terminalOutputNotificationSchema>
export type TerminalClosedNotification = z.infer<typeof terminalClosedNotificationSchema>
export type TerminalOwnershipNotification = z.infer<typeof terminalOwnershipNotificationSchema>
