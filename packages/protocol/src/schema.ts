import { z } from "zod"

export const protocolVersion = "0.1.0" as const

export const clientKindSchema = z.enum(["desktop", "web", "tablet", "phone", "cli"])
export const permissionModeSchema = z.enum(["ask", "plan", "build"])
export const sessionStateSchema = z.enum(["active", "waiting", "idle", "done", "failed"])
export const connectionKindSchema = z.enum(["local", "lan", "tailnet", "ssh", "relay", "wsl"])
export const approvalRiskSchema = z.enum(["normal", "hard-gate"])

export const runtimeSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoning: z.enum(["low", "medium", "high"]),
  permissionMode: permissionModeSchema,
  auto: z.boolean(),
})

export const machineSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  version: z.string().min(1),
  connection: connectionKindSchema,
  reachable: z.boolean(),
})

export const projectSchema = z.object({
  id: z.string().min(1),
  machineId: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
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
  requestedAt: z.string().datetime(),
})

export const approvalRuleSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  operation: z.string().min(1),
  command: z.string().min(1),
  createdBy: clientKindSchema,
  createdAt: z.string().datetime(),
})

export const threadItemSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("checkpoint"),
    label: z.string(),
    createdAt: z.string().datetime(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("user"),
    body: z.string(),
    createdAt: z.string().datetime(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("system"),
    body: z.string(),
    detail: z.string().optional(),
    createdAt: z.string().datetime(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("assistant"),
    body: z.string(),
    createdAt: z.string().datetime(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("receipt"),
    decision: z.enum(["allow-once", "always-project", "deny", "deny-explain"]),
    operation: z.string(),
    checkpoint: z.string(),
    client: clientKindSchema,
    explanation: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
  }),
])

export const artifactSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  title: z.string(),
  type: z.enum(["plan", "preview", "diff", "terminal"]),
  revision: z.number().int().positive(),
})

export const workspaceSnapshotSchema = z.object({
  protocolVersion: z.literal(protocolVersion),
  machine: machineSchema,
  project: projectSchema,
  sessions: z.array(sessionSummarySchema),
  activeSessionId: z.string(),
  approvals: z.array(approvalRequestSchema),
  approvalRules: z.array(approvalRuleSchema),
  thread: z.array(threadItemSchema),
  artifacts: z.array(artifactSchema),
})

export type ClientKind = z.infer<typeof clientKindSchema>
export type PermissionMode = z.infer<typeof permissionModeSchema>
export type Runtime = z.infer<typeof runtimeSchema>
export type Machine = z.infer<typeof machineSchema>
export type Project = z.infer<typeof projectSchema>
export type SessionSummary = z.infer<typeof sessionSummarySchema>
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>
export type ApprovalRule = z.infer<typeof approvalRuleSchema>
export type ThreadItem = z.infer<typeof threadItemSchema>
export type Artifact = z.infer<typeof artifactSchema>
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>
