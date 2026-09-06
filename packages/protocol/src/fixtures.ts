import type { Machine, WorkspaceSnapshot } from "./schema.js"
import { protocolVersion } from "./schema.js"

const now = "2026-08-25T21:52:00.000Z"

export function createEmptyWorkspace(machine: Machine): WorkspaceSnapshot {
  return {
    protocolVersion,
    machine,
    project: null,
    activeSessionId: null,
    sessions: [],
    approvals: [],
    approvalRules: [],
    thread: [],
    artifacts: [],
    workingPlans: [],
    annotations: [],
    skillEnablements: [],
  }
}

export const demoWorkspace: WorkspaceSnapshot = {
  protocolVersion,
  machine: {
    id: "machine-5c31a542e8960cfc8f00a529353d4944",
    name: "macbook-pro-m3",
    platform: "darwin",
    arch: "arm64",
    version: "0.0.1",
    connection: "local",
    reachable: true,
    providers: [],
  },
  project: {
    id: "project-acme-api",
    machineId: "machine-5c31a542e8960cfc8f00a529353d4944",
    name: "acme-api",
    path: "/Users/dev/src/acme-api",
    branch: "main",
  },
  activeSessionId: "session-billing",
  sessions: [
    {
      id: "session-billing",
      projectId: "project-acme-api",
      title: "Migrate billing webhooks to idempotent handlers with replay protection",
      state: "waiting",
      runtime: {
        provider: "claude-code",
        model: "sonnet-4.6",
        reasoning: "high",
        permissionMode: "build",
        auto: false,
      },
      changedFiles: 7,
      testsPassed: 42,
      testsFailed: 1,
      updatedAt: now,
    },
    {
      id: "session-onboarding",
      projectId: "project-acme-api",
      title: "design-studio: onboarding v3, three variants for the empty state",
      state: "active",
      runtime: {
        provider: "codex",
        model: "gpt-5.3-codex",
        reasoning: "medium",
        permissionMode: "plan",
        auto: false,
      },
      changedFiles: 3,
      testsPassed: 18,
      testsFailed: 0,
      updatedAt: "2026-08-25T21:48:00.000Z",
    },
    {
      id: "session-audit",
      projectId: "project-acme-api",
      title: "repo-audit: dependency and license review",
      state: "idle",
      runtime: {
        provider: "opencode",
        model: "glm-4.7",
        reasoning: "medium",
        permissionMode: "ask",
        auto: false,
      },
      changedFiles: 0,
      testsPassed: 0,
      testsFailed: 0,
      updatedAt: "2026-08-25T20:34:00.000Z",
    },
  ],
  approvals: [
    {
      id: "approval-migrate",
      sessionId: "session-billing",
      risk: "hard-gate",
      operation: "Apply a production database migration",
      command: "pnpm prisma migrate deploy",
      machine: "macbook-pro-m3",
      agent: "claude-code / sonnet-4.6",
      mode: "build",
      directory: "/Users/dev/.domovoi/worktrees/wt-billing-idem",
      affects: "Production database schema: replay_events and webhook idempotency index.",
      network: "api.stripe.com and production PostgreSQL",
      estimatedDuration: "20–40 seconds",
      checkpoint: "ckpt_7f21",
      requestedAt: now,
      execution: {
        state: "resolved",
        record: {
          version: 1,
          coverage: "command-and-script-text",
          cwd: ".",
          kind: "shell",
          entries: [{
            id: 0,
            source: { kind: "request" },
            parts: [{
              operator: null,
              argv: ["pnpm", "prisma", "migrate", "deploy"],
              expandsTo: [],
            }],
          }],
        },
        digest: `sha256:${"a".repeat(64)}`,
      },
    },
  ],
  approvalRules: [],
  thread: [
    {
      id: "thread-checkpoint",
      sessionId: "session-billing",
      kind: "checkpoint",
      label: "ckpt_7f21 · before provider handoff · 12:41",
      commit: "7".repeat(40),
      createdAt: "2026-08-25T21:41:00.000Z",
    },
    {
      id: "thread-user",
      sessionId: "session-billing",
      kind: "user",
      body: "The Stripe retries are double-charging. Make every webhook idempotent, add a replay table, and do not touch production config before you propose anything.",
      createdAt: "2026-08-25T21:42:00.000Z",
    },
    {
      id: "thread-handoff",
      sessionId: "session-billing",
      kind: "system",
      body: "Handed off codex / gpt-5.3-codex to claude-code / sonnet-4.6.",
      detail: "Thread, plan, worktree, diff, test results, and 2 open annotations carried over. Hidden reasoning and provider caches did not transfer.",
      createdAt: "2026-08-25T21:44:00.000Z",
    },
    {
      id: "thread-assistant",
      sessionId: "session-billing",
      kind: "assistant",
      body: "Suite is green except webhooks/replay.spec.ts; it asserts the old at-least-once behavior. Three needs a migration, so I will stop and ask.",
      createdAt: "2026-08-25T21:50:00.000Z",
    },
  ],
  artifacts: [
    {
      id: "artifact-plan",
      sessionId: "session-billing",
      title: "Idempotent webhook migration",
      type: "plan",
      revision: 3,
    },
    {
      id: "artifact-preview",
      sessionId: "session-billing",
      title: "Replay operations preview",
      type: "preview",
      revision: 2,
    },
  ],
  workingPlans: [
    {
      sessionId: "session-billing",
      revision: 7,
      structureRevision: 3,
      steps: [
        {
          id: "plan-step-replay-table",
          text: "Add a replay table with a unique event-id claim",
          status: "completed",
        },
        {
          id: "plan-step-claim-commit",
          text: "Make every handler claim-then-commit before side effects",
          status: "completed",
        },
        {
          id: "plan-step-migration",
          text: "Apply the migration on this machine's dev database",
          status: "in-progress",
        },
        {
          id: "plan-step-tests",
          text: "Rewrite replay.spec.ts to assert exactly-once delivery",
          status: "pending",
        },
      ],
      providerSync: {
        provider: "claude-code",
        model: "sonnet-4.6",
        providerThreadId: "thread-billing",
        structureRevision: 2,
        deliveredAt: "2026-08-25T21:50:00.000Z",
      },
      pendingEdit: {
        id: "plan-edit-migration-order",
        basedOnStructureRevision: 2,
        baseSteps: [
          {
            id: "plan-step-replay-table",
            text: "Add a replay table with a unique event-id claim",
          },
          {
            id: "plan-step-claim-commit",
            text: "Make every handler claim-then-commit before side effects",
          },
          {
            id: "plan-step-migration",
            text: "Apply the migration",
          },
          {
            id: "plan-step-tests",
            text: "Rewrite replay.spec.ts to assert exactly-once delivery",
          },
        ],
        draftSteps: [
          {
            id: "plan-step-replay-table",
            text: "Add a replay table with a unique event-id claim",
          },
          {
            id: "plan-step-claim-commit",
            text: "Make every handler claim-then-commit before side effects",
          },
          {
            id: "plan-step-tests",
            text: "Rewrite replay.spec.ts to assert exactly-once delivery",
          },
          {
            id: "plan-step-migration",
            text: "Apply the migration in staging before local development",
          },
        ],
        status: "conflicted",
        submittedAt: "2026-08-25T21:51:00.000Z",
        submittedBy: {
          client: "desktop",
          connectionId: "11111111-1111-4111-8111-111111111111",
          clientId: "desktop-primary",
        },
      },
      createdAt: "2026-08-25T21:45:00.000Z",
      updatedAt: now,
    },
  ],
  annotations: [
    {
      id: "annotation-migration-machine",
      sessionId: "session-billing",
      artifactId: "artifact-plan",
      anchor: {
        textQuote: "Apply the migration",
        cssSelector: "section.plan > li:nth-child(3)",
      },
      body: "Run this migration on the WSL staging machine first.",
      status: "open",
      origin: "tablet",
      thread: [{
        id: "annotation-reply-agent",
        body: "I will revise step three before continuing.",
        origin: "desktop",
        createdAt: "2026-08-25T21:51:00.000Z",
      }],
      createdAt: "2026-08-25T21:49:00.000Z",
      updatedAt: "2026-08-25T21:51:00.000Z",
    },
    {
      id: "annotation-replay-copy",
      sessionId: "session-billing",
      artifactId: "artifact-preview",
      variantId: "variant-b",
      anchor: {
        textQuote: "Replay operations",
        bbox: { x: 80, y: 164, width: 320, height: 56 },
      },
      body: "Keep this status visible while replay is running.",
      status: "open",
      origin: "phone",
      thread: [],
      createdAt: "2026-08-25T21:50:00.000Z",
      updatedAt: "2026-08-25T21:50:00.000Z",
    },
  ],
  skillEnablements: [],
}
