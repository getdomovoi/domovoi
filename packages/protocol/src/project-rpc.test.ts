import { describe, expect, it } from "vitest"

import {
  daemonAuthenticationErrorCode,
  daemonPersistenceUnavailableErrorCode,
  daemonShuttingDownErrorCode,
  demoWorkspace,
  deviceLabelMismatchErrorCode,
  devicePairingLimitErrorCode,
  fleetSnapshotOverflowErrorCode,
  isRefusedWithoutPersistence,
  localOwnerRequiredErrorCode,
  machineCredentialMissingErrorCode,
  maximumProjectCap,
  maximumProjectCloseSessions,
  phoneAndTabletRpcMethods,
  projectCapErrorCode,
  projectCapRefusalSchema,
  projectCloseConfirmationErrorCode,
  projectCloseConfirmationSchema,
  projectSwitchConfirmationErrorCode,
  protocolVersionMismatchErrorCode,
  repositoryGitFilterErrorCode,
  rpcMethodAuthorizations,
  rpcMethodMutations,
  rpcMethods,
  skillInstallErrorCode,
  toolInventoryParamsSchema,
  turnSkillSelectionErrorCode,
  type RpcMethod,
} from "./index.js"

const projectId = "project-acme-api"
const digest = `sha256:${"a".repeat(64)}`

// Every call that reads or changes one project's skills, tools or sessions
// can name the project. Left out, the daemon uses the focused project.
const projectScoped: ReadonlyArray<[RpcMethod, Record<string, unknown>]> = [
  ["session.create", { title: "Fix the build", runtime: demoWorkspace.sessions[0]!.runtime, client: "desktop" }],
  ["tool.inventory", {}],
  ["skill.list", {}],
  ["skill.inventory", {}],
  ["skill.read", { id: "skill-0123456789ab" }],
  ["skill.reviewRevision", { id: "skill-0123456789ab", contentDigest: digest }],
  ["skill.setEnabled", { id: "skill-0123456789ab", enabled: true, contentDigest: digest, manifest: { version: 1, capabilities: [] } }],
  ["skill.review", { id: "skill-0123456789ab", contentDigest: digest, decision: "trust" }],
  ["skill.installPreview", { source: { kind: "path", path: "/Users/dev/skills/review" } }],
  ["skill.install", { source: { kind: "path", path: "/Users/dev/skills/review" }, scope: "project", sourceDigest: digest }],
]

describe("project-scoped calls", () => {
  it.each(projectScoped)("%s takes an optional project id", (method, params) => {
    const schema = rpcMethods[method].params
    expect(schema.safeParse(params).success, "without projectId").toBe(true)
    expect(schema.parse({ ...params, projectId })).toMatchObject({ projectId })
    expect(schema.safeParse({ ...params, projectId: "" }).success, "empty").toBe(false)
    expect(schema.safeParse({ ...params, projectId: "p".repeat(257) }).success, "oversized").toBe(false)
  })

  it("keeps the tool inventory params strict", () => {
    expect(rpcMethods["tool.inventory"].params).toBe(toolInventoryParamsSchema)
    expect(toolInventoryParamsSchema.safeParse({ projectId, extra: true }).success).toBe(false)
  })
})

describe("project.close", () => {
  const confirmation = {
    kind: "project-close-confirmation",
    projectId,
    sessions: [{ id: "session-billing", title: "Billing", state: "active", workspacePath: "/worktrees/billing" }],
    sessionCount: 1,
    worktreeCount: 1,
  }

  it("names one project and returns the sessions confirmation listed", () => {
    expect(projectCloseConfirmationSchema.parse(confirmation)).toEqual(confirmation)
    expect(projectCloseConfirmationSchema.safeParse({ ...confirmation, sessionCount: 2 }).success).toBe(false)
    expect(projectCloseConfirmationSchema.safeParse({ ...confirmation, worktreeCount: 0 }).success).toBe(false)
    expect(projectCloseConfirmationSchema.safeParse({ ...confirmation, extra: true }).success).toBe(false)

    const params = rpcMethods["project.close"].params
    expect(params.parse({ projectId, client: "desktop" })).toEqual({ projectId, client: "desktop" })
    expect(params.parse({ projectId, client: "desktop", confirmation })).toEqual({ projectId, client: "desktop", confirmation })
    expect(params.safeParse({ projectId: "project-other", client: "desktop", confirmation }).success, "another project's confirmation").toBe(false)
    expect(params.safeParse({ client: "desktop" }).success).toBe(false)
    expect(params.safeParse({ projectId, client: "desktop", path: "/x" }).success).toBe(false)
  })

  it("reports each stopped session, and a stop it could not confirm", () => {
    const result = rpcMethods["project.close"].result
    const snapshot = structuredClone(demoWorkspace)
    const closed = {
      snapshot,
      sessions: [
        { sessionId: "session-billing", outcome: "stopped" },
        { sessionId: "session-onboarding", outcome: "unconfirmed" },
      ],
    }
    expect(result.parse(closed)).toMatchObject({ sessions: closed.sessions })
    expect(result.safeParse({ ...closed, sessions: [{ sessionId: "session-billing", outcome: "restarted" }] }).success).toBe(false)
    expect(result.safeParse({ ...closed, sessions: [closed.sessions[0], closed.sessions[0]] }).success, "listed twice").toBe(false)
    expect(result.safeParse({ ...closed, sessions: [], omittedSessions: 3 }).success).toBe(true)
    expect(result.safeParse({ ...closed, omittedSessions: 0 }).success).toBe(false)
    expect(result.safeParse({
      ...closed,
      sessions: Array.from({ length: maximumProjectCloseSessions + 1 }, (_, index) => ({ sessionId: `session-${index}`, outcome: "stopped" })),
    }).success).toBe(false)
  })

  it("is a control call that changes stored state, and never a phone's", () => {
    expect(rpcMethodAuthorizations["project.close"]).toBe("control")
    expect(rpcMethodMutations["project.close"]).toBe("mutating")
    expect(isRefusedWithoutPersistence("project.close")).toBe(true)
    // Ruling Q192 B: a phone opens a project, and never closes one.
    expect(phoneAndTabletRpcMethods.has("project.close")).toBe(false)
    expect(phoneAndTabletRpcMethods.has("project.open")).toBe(true)
  })
})

describe("the project cap refusal", () => {
  const refusal = { kind: "project_cap", cap: 3, activeProjectIds: ["project-a", "project-b", "project-c"] }

  it("states the cap and the projects holding it", () => {
    expect(projectCapRefusalSchema.parse(refusal)).toEqual(refusal)
    expect(projectCapRefusalSchema.safeParse({ ...refusal, activeProjectIds: ["project-a", "project-b"] }).success, "under the cap").toBe(false)
    expect(projectCapRefusalSchema.safeParse({ ...refusal, activeProjectIds: ["project-a", "project-a", "project-b"] }).success, "repeated").toBe(false)
    expect(projectCapRefusalSchema.safeParse({ ...refusal, cap: 0 }).success).toBe(false)
    expect(projectCapRefusalSchema.safeParse({ ...refusal, cap: maximumProjectCap + 1 }).success).toBe(false)
    expect(projectCapRefusalSchema.safeParse({ ...refusal, extra: true }).success).toBe(false)
  })

  it("has error codes of its own", () => {
    const codes = [
      daemonAuthenticationErrorCode,
      daemonShuttingDownErrorCode,
      projectSwitchConfirmationErrorCode,
      machineCredentialMissingErrorCode,
      protocolVersionMismatchErrorCode,
      devicePairingLimitErrorCode,
      daemonPersistenceUnavailableErrorCode,
      turnSkillSelectionErrorCode,
      fleetSnapshotOverflowErrorCode,
      deviceLabelMismatchErrorCode,
      skillInstallErrorCode,
      localOwnerRequiredErrorCode,
      repositoryGitFilterErrorCode,
      projectCapErrorCode,
      projectCloseConfirmationErrorCode,
    ]
    expect(new Set(codes).size).toBe(codes.length)
    expect(projectCapErrorCode).toBe(-32021)
    expect(projectCloseConfirmationErrorCode).toBe(-32022)
  })
})
