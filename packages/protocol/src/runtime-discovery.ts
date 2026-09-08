import { z } from "zod"

import { utf16MaxLength } from "./validation.js"

import { clientKindSchema, machineIdSchema } from "./identifiers.js"
import { permissionModeSchema, providerModelSchema, runtimeSchema } from "./schema.js"

// One end-to-end daemon budget, including readiness, connection and catalog.
// Clients should allow transport overhead beyond this and bound their own wait.
export const maximumRuntimeDiscoveryMs = 10_000

export const runtimeDiscoveryRefusals = {
  "auth-required": { action: "sign-in", retryable: false, message: "Sign in to this provider on the execution machine, then retry discovery." },
  missing: { action: "install", retryable: false, message: "Install this provider on the execution machine, then retry discovery." },
  "readiness-unknown": { action: "retry", retryable: true, message: "Provider readiness could not be verified. Check the provider on the execution machine, then retry discovery." },
  unsupported: { action: "choose-provider", retryable: false, message: "This daemon has no session adapter for this provider. Choose another provider." },
  timeout: { action: "retry", retryable: true, message: "Runtime discovery timed out. Retry discovery or choose another provider." },
  "discovery-failed": { action: "retry", retryable: true, message: "The provider refused runtime discovery or returned an invalid catalog. Check the provider on the execution machine, then retry discovery." },
  "no-models": { action: "configure", retryable: false, message: "The provider returned no usable models. Configure model access on the execution machine, then retry discovery." },
} as const

const providerId = z.string().trim().min(1).check(utf16MaxLength(64))
export const runtimeDiscoverParamsSchema = z.object({
  provider: providerId,
  client: clientKindSchema,
}).strict()

const identity = { machineId: machineIdSchema, provider: providerId }
export const runtimeDiscoverResultSchema = z.discriminatedUnion("status", [
  z.object({
    ...identity,
    status: z.literal("ready"),
    models: z.array(providerModelSchema).min(1).max(5_000),
    defaultRuntime: runtimeSchema,
    permissionModes: z.array(permissionModeSchema).min(1).max(3),
    supportsAuto: z.boolean(),
  }).strict(),
  z.object({
    ...identity,
    status: z.literal("unavailable"),
    reason: z.enum(["auth-required", "missing", "readiness-unknown", "unsupported", "timeout", "discovery-failed", "no-models"]),
    action: z.enum(["sign-in", "install", "retry", "choose-provider", "configure"]),
    retryable: z.boolean(),
    message: z.string().trim().min(1).check(utf16MaxLength(512)),
  }).strict(),
]).superRefine((result, context) => {
  if (result.status === "unavailable") {
    const refusal = runtimeDiscoveryRefusals[result.reason]
    for (const key of ["action", "retryable", "message"] as const) {
      if (result[key] !== refusal[key]) context.addIssue({ code: "custom", path: [key], message: "Refusal must match its reason" })
    }
    return
  }
  const runtime = result.defaultRuntime
  const selected = result.models.find((model) => model.id === runtime.model)
  if (runtime.provider !== result.provider || !selected || runtime.reasoning !== selected.defaultReasoningEffort) {
    context.addIssue({ code: "custom", path: ["defaultRuntime"], message: "Default runtime must use a discovered model and its default reasoning effort" })
  }
  if (runtime.auto || !result.permissionModes.includes(runtime.permissionMode)) {
    context.addIssue({ code: "custom", path: ["defaultRuntime"], message: "Default runtime must use a supported permission mode with Auto off" })
  }
  if (new Set(result.permissionModes).size !== result.permissionModes.length) {
    context.addIssue({ code: "custom", path: ["permissionModes"], message: "Permission modes must be unique" })
  }
  if (result.supportsAuto && !result.permissionModes.includes("build")) {
    context.addIssue({ code: "custom", path: ["supportsAuto"], message: "Auto requires Build mode" })
  }
  const ids = new Set<string>()
  for (const [index, model] of result.models.entries()) {
    if (model.provider !== result.provider || !model.id.trim() || model.id.length > 256 || ids.has(model.id)) {
      context.addIssue({ code: "custom", path: ["models", index], message: "Models must have unique runtime-compatible ids from this provider" })
    }
    ids.add(model.id)
  }
})

export type RuntimeDiscoverParams = z.infer<typeof runtimeDiscoverParamsSchema>
export type RuntimeDiscoverResult = z.infer<typeof runtimeDiscoverResultSchema>
export type RuntimeDiscoveryRefusalReason = keyof typeof runtimeDiscoveryRefusals
