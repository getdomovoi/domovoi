import {
  demoWorkspace,
  sessionTransferContractVersion,
  skillSummarySchema,
  type FleetMachine,
  type SessionTransferPreview,
  type SkillSummary,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState, type ComponentProps } from "react"
import { afterEach, expect, it, vi } from "vitest"

import type { QueuedMessage } from "./turn-queue"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

type ThreadProps = ComponentProps<typeof Thread>

const baseHandlers = (): Pick<ThreadProps,
  | "onResolve"
  | "onSetRuntime"
  | "onForkSession"
  | "onListModels"
  | "onNewSession"
  | "onSend"
  | "onCheckpoint"
  | "onRestoreCheckpoint"
  | "onPauseSession"
> => ({
  onResolve: vi.fn(async () => {}),
  onSetRuntime: vi.fn(async () => {}),
  onForkSession: vi.fn(async () => {}),
  onListModels: vi.fn(async () => []),
  onNewSession: vi.fn(),
  onSend: vi.fn(async () => {}),
  onCheckpoint: vi.fn(async () => {}),
  onRestoreCheckpoint: vi.fn(async () => {}),
  onPauseSession: vi.fn(async () => {}),
})

function ThreadWith({
  connected = true,
  snapshot = structuredClone(demoWorkspace),
  ...props
}: Partial<ThreadProps> & { connected?: boolean, snapshot?: WorkspaceSnapshot }) {
  const [queued, setQueued] = useState<QueuedMessage>()
  snapshot.approvals = []
  return (
    <Thread
      {...baseHandlers()}
      {...props}
      snapshot={snapshot}
      connected={connected}
      queued={queued}
      onQueuedChange={setQueued}
    />
  )
}

const field = () => screen.getByLabelText("Message") as HTMLTextAreaElement

async function submit(value: string) {
  const user = userEvent.setup()
  await user.clear(field())
  await user.type(field(), value)
  await user.keyboard("{Enter}")
  return user
}

function reviewedSkill(character: string, name: string): SkillSummary {
  return skillSummarySchema.parse({
    id: `skill-${character.repeat(12)}`,
    name,
    description: `${name} instructions`,
    path: `/skills/${name}/SKILL.md`,
    scope: "user",
    source: "agents",
    manifest: { version: 1, capabilities: ["filesystem.read"] },
    contentDigest: `sha256:${character.repeat(64)}`,
    signature: { state: "unsigned" },
    trust: { state: "untrusted", reason: "unsigned" },
  })
}

function withSkills(skills: readonly SkillSummary[]): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.skillEnablements = skills.map((skill) => ({
    projectId: snapshot.project!.id,
    skillId: skill.id,
    enabled: true,
    contentDigest: skill.contentDigest,
    manifest: skill.manifest,
    reviewedAt: "2026-09-19T12:00:00.000Z",
    reviewedBy: { client: "desktop" },
  }))
  return snapshot
}

function fleetFor(snapshot: WorkspaceSnapshot): [FleetMachine, FleetMachine] {
  const local: FleetMachine = {
    id: snapshot.machine.id,
    label: snapshot.machine.name,
    platform: snapshot.machine.platform,
    arch: snapshot.machine.arch,
    version: snapshot.machine.version,
    connection: "local",
    capabilities: ["sessions"],
    protocolVersion: "0.1.0",
    transports: [{ kind: "local", endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true }],
    heartbeat: { state: "online", lastSeenAt: "2026-09-19T12:00:00.000Z" },
    health: "healthy",
    self: true,
  }
  return [local, {
    ...local,
    id: `machine-${"b".repeat(32)}`,
    label: "hetzner-cx42",
    connection: "tailnet",
    transports: [{ kind: "tailnet", endpoint: "wss://hetzner-cx42:47831/rpc", authenticated: true }],
    self: false,
  }]
}

it("opens from typed slash text and keeps all six design commands while dimming nonmatches", async () => {
  const user = userEvent.setup()
  render(<ThreadWith />)

  await user.type(field(), "/r")

  const list = screen.getByRole("listbox", { name: "THIS TURN" })
  expect(within(list).getAllByRole("option")).toHaveLength(6)
  expect(within(list).getByRole("option", { name: "/run pnpm prisma migrate deploy" }).getAttribute("data-match")).toBe("true")
  expect(within(list).getByRole("option", { name: "/mode plan · ask · build" }).getAttribute("data-match")).toBe("false")
  expect(screen.getByText("THIS TURN")).toBeTruthy()
  expect(screen.getByText(/to go somewhere$/u)).toBeTruthy()
})

it("renders the slash list outside the composer so upward opening cannot be clipped", async () => {
  const user = userEvent.setup()
  render(<ThreadWith />)

  await user.type(field(), "/r")
  const composer = document.querySelector("[data-workspace-composer]")
  if (!composer) throw new Error("The composer card is missing")
  expect(composer.contains(screen.getByRole("listbox", { name: "THIS TURN" }))).toBe(false)
})

it("only fills a picked command until explicit submit", async () => {
  const user = userEvent.setup()
  const onSend = vi.fn(async () => {})
  render(<ThreadWith onSend={onSend} />)

  await user.type(field(), "/r")
  await user.click(screen.getByRole("option", { name: "/replan from step 3" }))

  expect(field().value).toBe("/replan ")
  expect(onSend).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(field())
})

it("dispatches mode through the runtime setter without sending", async () => {
  const onSetRuntime = vi.fn(async () => {})
  const onSend = vi.fn(async () => {})
  render(<ThreadWith onSetRuntime={onSetRuntime} onSend={onSend} />)

  await submit("/mode plan")

  expect(onSetRuntime).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "plan", auto: false }))
  expect(onSend).not.toHaveBeenCalled()
  expect(field().value).toBe("")
})

it("restores only a checkpoint belonging to the active session", async () => {
  const snapshot = structuredClone(demoWorkspace)
  const activeCheckpoint = snapshot.thread.find((item) =>
    item.sessionId === snapshot.activeSessionId && item.kind === "checkpoint" && item.commit
  )
  if (!activeCheckpoint) throw new Error("Fixture has no active-session checkpoint")
  const onRestoreCheckpoint = vi.fn(async () => {})
  render(<ThreadWith snapshot={snapshot} onRestoreCheckpoint={onRestoreCheckpoint} />)

  await submit("/revert checkpoint-from-another-session")
  expect(onRestoreCheckpoint).not.toHaveBeenCalled()
  expect(field().value).toBe("/revert checkpoint-from-another-session")
  expect(screen.getByText(/Usage: \/revert <checkpoint-id>/u)).toBeTruthy()

  await submit(`/revert ${activeCheckpoint.id}`)
  expect(onRestoreCheckpoint).toHaveBeenCalledWith(snapshot.activeSessionId, activeCheckpoint.id)
})

it("updates the pending turn skill selection without sending", async () => {
  const alpha = reviewedSkill("a", "alpha")
  const snapshot = withSkills([alpha])
  const onSend = vi.fn(async () => {})
  render(<ThreadWith snapshot={snapshot} skillCatalog={[alpha]} skillNames={{ [alpha.id]: alpha.name }} onSend={onSend} />)

  await submit("/skill alpha")
  expect(onSend).not.toHaveBeenCalled()

  await submit("Continue with the review")
  expect(onSend).toHaveBeenCalledWith(snapshot.activeSessionId, "Continue with the review", {
    mode: "turn-explicit",
    skills: [{ skillId: alpha.id, review: { contentDigest: alpha.contentDigest, manifest: alpha.manifest } }],
  })
})

it("keeps ambiguous skill arguments editable and performs no mutation", async () => {
  const first = reviewedSkill("a", "review")
  const second = reviewedSkill("b", "review")
  const snapshot = withSkills([first, second])
  const onSend = vi.fn(async () => {})
  render(<ThreadWith snapshot={snapshot} skillCatalog={[first, second]} onSend={onSend} />)

  await submit("/skill review")

  expect(field().value).toBe("/skill review")
  expect(screen.getByText(/Usage: \/skill <reviewed-skill>/u)).toBeTruthy()
  expect(onSend).not.toHaveBeenCalled()
})

it("resolves a handoff target and opens transfer preflight without moving", async () => {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.sessions = snapshot.sessions.map((session) => {
    const { activeTurnId: _activeTurnId, ...rest } = session
    return { ...rest, state: "idle" as const, workspacePath: "/worktrees/session" }
  })
  snapshot.activeSessionId = snapshot.sessions[0]!.id
  const [local, target] = fleetFor(snapshot)
  const preview: SessionTransferPreview = {
    allowed: true,
    contractVersion: sessionTransferContractVersion,
    sessionId: snapshot.activeSessionId,
    sourceMachineId: local.id,
    targetMachineId: target.id,
    intentDigest: `sha256:${"a".repeat(64)}`,
    project: {
      sourceProjectId: snapshot.project!.id,
      targetProjectId: "project-two",
      lineageCommit: "b".repeat(40),
      sourceHeadCommit: "c".repeat(40),
    },
    coverage: { included: [{ kind: "repository" }], excluded: [], warnings: [] },
  }
  const onPreviewTransfer = vi.fn(async () => preview)
  const onTransferSession = vi.fn(async () => { throw new Error("must not move before confirmation") })
  render(<ThreadWith
    snapshot={snapshot}
    fleet={[local, target].map((machine) => ({ kind: "machine", machine }))}
    currentMachineId={local.id}
    onPreviewTransfer={onPreviewTransfer}
    onTransferSession={onTransferSession}
  />)

  await submit("/handoff hetzner-cx42")

  expect(await screen.findByRole("heading", { name: "Move this session to another machine" })).toBeTruthy()
  await waitFor(() => expect(onPreviewTransfer).toHaveBeenCalledOnce())
  expect(onTransferSession).not.toHaveBeenCalled()
})

it("sends run and replan as explicit agent intents through the ordinary send path", async () => {
  const onSend = vi.fn(async () => {})
  render(<ThreadWith onSend={onSend} />)

  await submit("/run pnpm test")
  await submit("/replan from step 3")
  await submit("/replan")

  expect(onSend).toHaveBeenNthCalledWith(1, demoWorkspace.activeSessionId, "Run this command in the worktree:\n\npnpm test", undefined)
  expect(onSend).toHaveBeenNthCalledWith(2, demoWorkspace.activeSessionId, "Replan the remaining work from step 3.", undefined)
  expect(onSend).toHaveBeenNthCalledWith(3, demoWorkspace.activeSessionId, "Replan the remaining work while preserving completed steps and prior plan history.", undefined)
})

it("queues an explicit run intent without bypassing a running turn", async () => {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!.activeTurnId = "turn-running"
  const onSend = vi.fn(async () => {})
  render(<ThreadWith snapshot={snapshot} onSend={onSend} />)

  await submit("/run pnpm test")

  expect(onSend).not.toHaveBeenCalled()
  expect(screen.getByText(/Run this command in the worktree:\s+pnpm test/u)).toBeTruthy()
  expect(screen.getByText("queued, sends when this turn ends")).toBeTruthy()
})

it("keeps invalid and missing arguments editable with usage and no mutation", async () => {
  const onSend = vi.fn(async () => {})
  const onSetRuntime = vi.fn(async () => {})
  const onRestoreCheckpoint = vi.fn(async () => {})
  render(<ThreadWith onSend={onSend} onSetRuntime={onSetRuntime} onRestoreCheckpoint={onRestoreCheckpoint} />)

  await submit("/mode")

  expect(field().value).toBe("/mode")
  expect(screen.getByText(/Usage: \/mode <plan\|ask\|build>/u)).toBeTruthy()
  expect(onSend).not.toHaveBeenCalled()
  expect(onSetRuntime).not.toHaveBeenCalled()
  expect(onRestoreCheckpoint).not.toHaveBeenCalled()
})

it("closes model and mode menus when slash commands open", async () => {
  const user = userEvent.setup()
  render(<ThreadWith />)

  const model = screen.getByRole("button", { name: /claude-code · sonnet 4\.6/u })
  await user.click(model)
  expect(model.getAttribute("aria-expanded")).toBe("true")
  await user.click(field())
  await user.type(field(), "/")
  expect(model.getAttribute("aria-expanded")).toBe("false")

  await user.clear(field())
  await user.click(screen.getByRole("button", { name: /^Mode:/u }))
  expect(screen.getByRole("listbox", { name: "Permission modes" })).toBeTruthy()
  await user.click(field())
  await user.type(field(), "/")
  expect(screen.queryByRole("listbox", { name: "Permission modes" })).toBeNull()
})

it("keeps slash commands closed while offline", async () => {
  const user = userEvent.setup()
  render(<ThreadWith connected={false} />)

  expect(screen.queryByRole("button", { name: "Open slash commands" })).toBeNull()
  await user.type(field(), "/r")
  expect(screen.queryByRole("listbox", { name: "THIS TURN" })).toBeNull()
})
