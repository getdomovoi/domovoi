import { z } from "zod"
import { utf16MaxLength } from "./validation.js"

export const skillCapabilitySchema = z.enum([
  "filesystem.read", "filesystem.write", "process.execute", "network.connect", "secrets.read", "preview.render",
])

const capabilitiesSchema = z.array(skillCapabilitySchema).max(32).refine(
  (values) => new Set(values).size === values.length, "Capabilities must be unique",
)
const allScopeSchema = z.object({ kind: z.literal("all") }).strict()
const literalNameSchema = z.string().min(1).check(utf16MaxLength(2_048)).refine(
  (value) => !/\p{Cc}/u.test(value), "Names cannot contain control characters",
)
const pathTargetSchema = z.object({
  root: z.enum(["workspace", "absolute"]),
  path: literalNameSchema,
  recursive: z.boolean(),
}).strict().refine(({ root, path }) => {
  if (path.includes("\\")) return false
  if (root === "workspace") {
    return path === "." || (!path.startsWith("/") && !/^[A-Za-z]:/.test(path)
      && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."))
  }
  if (path === "/" || /^[A-Z]:\/$/.test(path)) return true
  const relative = path.startsWith("/") ? path.slice(1) : /^[A-Z]:\//.test(path) ? path.slice(3) : undefined
  return relative !== undefined && relative.split("/").every((part) => part !== "" && part !== "." && part !== "..")
}, "Paths must use canonical forward slashes and an explicit root")
const pathScopeSchema = z.object({
  kind: z.literal("paths"),
  paths: z.array(pathTargetSchema).min(1).max(128).refine(
    (values) => new Set(values.map((value) => JSON.stringify([value.root, value.path, value.recursive]))).size === values.length,
    "Paths must be unique",
  ),
}).strict()
const commandTargetSchema = z.object({
  executable: literalNameSchema,
  args: z.array(z.string().check(utf16MaxLength(8_192)).refine(
    (value) => !value.includes(String.fromCharCode(0)), "Arguments cannot contain NUL",
  )).max(64),
}).strict()
const commandScopeSchema = z.object({
  kind: z.literal("commands"),
  commands: z.array(commandTargetSchema).min(1).max(32).refine(
    (values) => new Set(values.map((value) => JSON.stringify([value.executable, value.args]))).size === values.length,
    "Commands must be unique",
  ),
}).strict()
const hostSchema = z.string().min(1).check(utf16MaxLength(253)).refine((value) => {
  if (!/^[a-z0-9.:[\]-]+$/.test(value)) return false
  if (!value.startsWith("[") && value.split(".").some(
    (part) => part.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part),
  )) return false
  try {
    const parsed = new URL(`http://${value}`)
    return parsed.hostname === value && parsed.port === "" && !value.endsWith(".")
  } catch { return false }
}, "Hosts must be canonical hostnames or IP literals without ports, wildcards or schemes")
const hostScopeSchema = z.object({
  kind: z.literal("hosts"),
  hosts: z.array(hostSchema).min(1).max(128).refine((values) => new Set(values).size === values.length, "Hosts must be unique"),
}).strict()
const nameScopeSchema = z.object({
  kind: z.literal("names"),
  names: z.array(literalNameSchema).min(1).max(128).refine((values) => new Set(values).size === values.length, "Names must be unique"),
}).strict()

export const skillCapabilityScopeDeclarationSchema = z.discriminatedUnion("capability", [
  z.object({ capability: z.literal("filesystem.read"), scope: z.union([allScopeSchema, pathScopeSchema]) }).strict(),
  z.object({ capability: z.literal("filesystem.write"), scope: z.union([allScopeSchema, pathScopeSchema]) }).strict(),
  z.object({ capability: z.literal("process.execute"), scope: z.union([allScopeSchema, commandScopeSchema]) }).strict(),
  z.object({ capability: z.literal("network.connect"), scope: z.union([allScopeSchema, hostScopeSchema]) }).strict(),
  z.object({ capability: z.literal("secrets.read"), scope: z.union([allScopeSchema, nameScopeSchema]) }).strict(),
  z.object({ capability: z.literal("preview.render"), scope: allScopeSchema }).strict(),
])

export const skillCapabilityManifestSchema = z.discriminatedUnion("version", [
  z.object({ version: z.literal(1), capabilities: capabilitiesSchema }).strict(),
  z.object({
    version: z.literal(2),
    capabilities: capabilitiesSchema,
    scopes: z.array(skillCapabilityScopeDeclarationSchema).max(6),
  }).strict().superRefine((manifest, context) => {
    const scopes = new Set(manifest.scopes.map((entry) => entry.capability))
    if (scopes.size !== manifest.scopes.length || scopes.size !== manifest.capabilities.length
      || manifest.capabilities.some((capability) => !scopes.has(capability))) {
      context.addIssue({ code: "custom", path: ["scopes"], message: "Each capability must have exactly one scope declaration" })
    }
  }),
]).refine((value) => JSON.stringify(value).length <= 64 * 1_024, "Capability declarations exceed 64 Ki UTF-16 code units")

type Manifest = z.infer<typeof skillCapabilityManifestSchema>
export type SkillCapabilityScopeDeclaration = z.infer<typeof skillCapabilityScopeDeclarationSchema>
export type SkillDeclaredScope = SkillCapabilityScopeDeclaration["scope"]
export type SkillDeclaredScopeChange = {
  capability: z.infer<typeof skillCapabilitySchema>
  change: "widened" | "narrowed" | "changed"
  gained: boolean
  lost: boolean
  before: SkillDeclaredScope
  after: SkillDeclaredScope
}
export type SkillDeclaredScopeComparison =
  | { state: "unknown"; reason: "baseline" | "current" }
  | { state: "known"; changes: SkillDeclaredScopeChange[] }

function pathCovers(cover: z.infer<typeof pathTargetSchema>, target: z.infer<typeof pathTargetSchema>): boolean {
  if (cover.root !== target.root) return false
  if (cover.path === target.path) return cover.recursive || !target.recursive
  if (!cover.recursive) return false
  const prefix = cover.path === "." ? "" : cover.path.endsWith("/") ? cover.path : `${cover.path}/`
  return target.path !== "." && target.path.startsWith(prefix)
}

function scopeCovers(cover: SkillDeclaredScope, target: SkillDeclaredScope): boolean {
  if (cover.kind === "all") return true
  if (cover.kind === "paths" && target.kind === "paths") return target.paths.every((path) => cover.paths.some((candidate) => pathCovers(candidate, path)))
  if (cover.kind === "hosts" && target.kind === "hosts") return target.hosts.every((host) => cover.hosts.includes(host))
  if (cover.kind === "names" && target.kind === "names") return target.names.every((name) => cover.names.includes(name))
  if (cover.kind === "commands" && target.kind === "commands") return target.commands.every((command) => cover.commands.some(
    (candidate) => candidate.executable === command.executable && JSON.stringify(candidate.args) === JSON.stringify(command.args),
  ))
  return false
}

export function compareSkillDeclaredScopes(baseline: Manifest | undefined, current: Manifest): SkillDeclaredScopeComparison {
  if (!baseline || baseline.version === 1) return { state: "unknown", reason: "baseline" }
  if (current.version === 1) return { state: "unknown", reason: "current" }
  const changes: SkillDeclaredScopeChange[] = []
  for (const after of current.scopes) {
    const before = baseline.scopes.find((entry) => entry.capability === after.capability)
    if (!before) continue // Capability gains are a separate, higher-priority tier.
    const containsBefore = scopeCovers(after.scope, before.scope)
    const containsAfter = scopeCovers(before.scope, after.scope)
    if (containsBefore && containsAfter) continue
    changes.push({ capability: after.capability, before: before.scope, after: after.scope,
      change: containsBefore ? "widened" : containsAfter ? "narrowed" : "changed",
      gained: !containsAfter, lost: !containsBefore })
  }
  return { state: "known", changes }
}

export function skillCapabilityManifestsEqual(left: Manifest, right: Manifest): boolean {
  if (left.version !== right.version || left.capabilities.length !== right.capabilities.length
    || left.capabilities.some((capability) => !right.capabilities.includes(capability))) return false
  if (left.version === 1) return true
  const comparison = compareSkillDeclaredScopes(left, right)
  return comparison.state === "known" && comparison.changes.length === 0
}
