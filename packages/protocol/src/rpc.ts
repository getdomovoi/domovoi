import { z } from "zod"

import {
  annotationAnchorSchema,
  approvalDecisionSchema,
  clientKindSchema,
  providerModelsSchema,
  runtimeSchema,
  workspaceSnapshotSchema,
} from "./schema.js"

export const requestIdSchema = z.union([z.string(), z.number()])

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
  provider: z.literal("codex"),
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
  "system.pauseAll": {
    params: systemPauseAllParamsSchema,
    result: workspaceSnapshotSchema,
  },
  "workspace.get": { params: z.object({}), result: workspaceSnapshotSchema },
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
