import { describe, expect, it } from "vitest"

import {
  approvalRequestSchema,
  approvalRuleSchema,
  demoWorkspace,
  executionRecordSchema,
  executionResolutionSchema,
  resolvedExecutionSchema,
  workspaceSnapshotSchema,
} from "./index.js"

const digest = (character: string) => `sha256:${character.repeat(64)}`

const record = {
  version: 1,
  coverage: "command-and-script-text",
  cwd: "packages/api",
  kind: "shell",
  entries: [
    {
      id: 0,
      source: { kind: "request" },
      parts: [{
        operator: null,
        argv: ["pnpm", "run", "test", "--", "--reporter=dot"],
        expandsTo: [1, 2, 4],
      }],
    },
    {
      id: 1,
      source: {
        kind: "package-script",
        manager: "pnpm",
        manifest: "packages/api/package.json",
        name: "pretest",
        phase: "pre",
        arguments: [],
        sourceDigest: digest("a"),
      },
      parts: [{ operator: null, argv: ["eslint", "."], expandsTo: [] }],
    },
    {
      id: 2,
      source: {
        kind: "package-script",
        manager: "pnpm",
        manifest: "packages/api/package.json",
        name: "test",
        phase: "main",
        arguments: ["--reporter=dot"],
        sourceDigest: digest("b"),
      },
      parts: [{ operator: null, argv: ["pnpm", "run", "unit"], expandsTo: [3] }],
    },
    {
      id: 3,
      source: {
        kind: "package-script",
        manager: "pnpm",
        manifest: "packages/api/package.json",
        name: "unit",
        phase: "main",
        arguments: [],
        sourceDigest: digest("c"),
      },
      parts: [{ operator: null, argv: ["vitest", "run"], expandsTo: [] }],
    },
    {
      id: 4,
      source: {
        kind: "package-script",
        manager: "pnpm",
        manifest: "packages/api/package.json",
        name: "posttest",
        phase: "post",
        arguments: [],
        sourceDigest: digest("d"),
      },
      parts: [{ operator: null, argv: ["node", "cleanup.js"], expandsTo: [] }],
    },
  ],
} as const

const resolved = {
  state: "resolved",
  record,
  digest: digest("e"),
} as const

describe("resolved execution records", () => {
  it("carries a bounded script expansion graph without raw script bodies", () => {
    expect(executionRecordSchema.parse(record)).toEqual(record)
    expect(executionRecordSchema.safeParse({
      ...record,
      entries: record.entries.map((entry, index) => index === 1
        ? { ...entry, source: { ...entry.source, body: "eslint ." } }
        : entry),
    }).success).toBe(false)
  })

  it("accepts a project-scoped file operation", () => {
    expect(executionRecordSchema.parse({
      version: 1,
      coverage: "tool-and-workspace-scope",
      cwd: ".",
      kind: "workspace-file-tool",
      tool: "Edit",
      scope: "workspace",
    })).toEqual({
      version: 1,
      coverage: "tool-and-workspace-scope",
      cwd: ".",
      kind: "workspace-file-tool",
      tool: "Edit",
      scope: "workspace",
    })
  })

  it.each([
    ["absolute cwd", { ...record, cwd: "/tmp/repo" }],
    ["parent cwd", { ...record, cwd: "../repo" }],
    ["non-canonical cwd", { ...record, cwd: "packages/./api" }],
    ["non-sequential entry id", {
      ...record,
      entries: record.entries.map((entry, index) => index === 3 ? { ...entry, id: 8 } : entry),
    }],
    ["unreferenced expansion", {
      ...record,
      entries: record.entries.map((entry, index) => index === 0
        ? { ...entry, parts: [{ ...entry.parts[0], expandsTo: [1, 2] }] }
        : entry),
    }],
    ["backward expansion", {
      ...record,
      entries: record.entries.map((entry, index) => index === 3
        ? { ...entry, parts: [{ ...entry.parts[0], expandsTo: [2] }] }
        : entry),
    }],
    ["leading operator", {
      ...record,
      entries: record.entries.map((entry, index) => index === 1
        ? { ...entry, parts: [{ ...entry.parts[0], operator: "&&" }] }
        : entry),
    }],
  ] as const)("rejects %s", (_label, candidate) => {
    expect(executionRecordSchema.safeParse(candidate).success).toBe(false)
  })

  it("bounds unresolved reasons and resolved digests", () => {
    expect(executionResolutionSchema.parse(resolved)).toEqual(resolved)
    expect(executionResolutionSchema.parse({
      state: "unresolved",
      reason: "unsupported-syntax",
    })).toEqual({ state: "unresolved", reason: "unsupported-syntax" })
    expect(executionResolutionSchema.safeParse({
      state: "unresolved",
      reason: "partly-resolved",
    }).success).toBe(false)
    expect(executionResolutionSchema.safeParse({
      ...resolved,
      digest: "sha256:short",
    }).success).toBe(false)
  })
})

describe("standing approval execution state", () => {
  const commonRule = {
    id: "rule-test",
    projectId: "project-test",
    operation: "Run tests",
    command: "pnpm test",
    createdBy: "desktop",
    createdAt: "2026-09-03T18:00:00.000Z",
  } as const

  it("requires active rules to carry their resolved execution", () => {
    const active = { ...commonRule, status: "active", execution: resolved } as const
    expect(approvalRuleSchema.parse(active)).toEqual(active)
    expect(approvalRuleSchema.safeParse(commonRule).success).toBe(false)
    expect(approvalRuleSchema.safeParse({
      ...commonRule,
      status: "active",
      execution: { state: "unresolved", reason: "unsupported-syntax" },
    }).success).toBe(false)
  })

  it("keeps an inactive legacy rule and its replacement lineage auditable", () => {
    const inactive = {
      ...commonRule,
      status: "inactive",
      inactiveReason: "legacy-text-only",
      inactivatedAt: "2026-09-03T18:30:00.000Z",
      replacedByRuleId: "rule-test-v1",
    } as const
    expect(approvalRuleSchema.parse(inactive)).toEqual(inactive)
    expect(approvalRuleSchema.safeParse({ ...inactive, execution: resolved }).success).toBe(false)
  })

  it("tells an approval card which inactive rules require reapproval", () => {
    const request = {
      id: "approval-test",
      sessionId: "session-test",
      risk: "normal",
      operation: "Run tests",
      command: "pnpm test",
      machine: "workstation",
      agent: "codex / gpt-5",
      mode: "build",
      directory: "/worktrees/session-test",
      affects: "Project files",
      network: "None",
      estimatedDuration: "Unknown",
      checkpoint: "abc123",
      requestedAt: "2026-09-03T18:30:00.000Z",
      execution: resolved,
      reapproval: {
        reason: "legacy-text-only",
        inactiveRuleIds: ["rule-old"],
      },
    } as const
    expect(approvalRequestSchema.parse(request)).toEqual(request)
    expect(approvalRequestSchema.safeParse({
      ...request,
      reapproval: { ...request.reapproval, inactiveRuleIds: [] },
    }).success).toBe(false)
  })

  it("binds reapproval and replacement links to rules in the same snapshot", () => {
    const snapshot = structuredClone(demoWorkspace)
    const inactive = {
      ...commonRule,
      projectId: snapshot.project!.id,
      status: "inactive",
      inactiveReason: "legacy-text-only",
      inactivatedAt: "2026-09-03T18:30:00.000Z",
      replacedByRuleId: "rule-test-v1",
    } as const
    const active = {
      ...commonRule,
      id: "rule-test-v1",
      projectId: snapshot.project!.id,
      status: "active",
      execution: resolvedExecutionSchema.parse(resolved),
    } as const
    snapshot.approvalRules = [inactive, active]
    snapshot.approvals[0]!.reapproval = {
      reason: "legacy-text-only",
      inactiveRuleIds: [inactive.id],
    }
    expect(workspaceSnapshotSchema.safeParse(snapshot).success).toBe(true)

    snapshot.approvals[0]!.reapproval.inactiveRuleIds = ["rule-missing"]
    expect(workspaceSnapshotSchema.safeParse(snapshot).success).toBe(false)
    snapshot.approvals[0]!.reapproval.inactiveRuleIds = [inactive.id]
    snapshot.approvalRules = [inactive]
    expect(workspaceSnapshotSchema.safeParse(snapshot).success).toBe(false)
  })
})
