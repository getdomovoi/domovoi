import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import {
  repositoryGitFilterErrorCode,
  type ProviderRuntime,
  type RepositoryGitFilterRefusal,
  type RepositoryTrustState,
  type ToolInventory,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  fail,
  installFakeWebSocket,
  notify,
  respond,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness

beforeEach(() => {
  try { localStorage.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
})

afterEach(() => {
  cleanup()
  harness.uninstall()
  vi.restoreAllMocks()
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

const digest = `sha256:${"a".repeat(64)}`
// tool.inventory's digest over the git filter block it lists.
const reviewDigest = `sha256:${"b".repeat(64)}`
const notTrusted: RepositoryTrustState = { state: "untrusted", reason: "not-trusted" }

const codex: ProviderRuntime = { id: "codex", command: "codex", status: "ready", sessionCapable: true, version: "1.0.0" }

function refusal(snapshot: WorkspaceSnapshot, trust: RepositoryTrustState = notTrusted): RepositoryGitFilterRefusal {
  return {
    kind: "repository-git-filter",
    projectId: snapshot.project!.id,
    configDigest: digest,
    trust,
    drivers: [{ name: "sops", scope: "local" }],
    omittedDrivers: 0,
  }
}

function toolInventory(snapshot: WorkspaceSnapshot): ToolInventory {
  const { id, name, platform, arch, version } = snapshot.machine
  return {
    machine: { id, name, platform, arch, version },
    repository: {
      projectId: snapshot.project!.id,
      root: "~/src/acme-api",
      configDigest: digest,
      trust: notTrusted,
      gitFilters: {
        files: [{ path: ".git/config", scope: "local" }],
        entries: [{ driver: "sops", operation: "smudge", command: "sops -d", required: "true", file: ".git/config", scope: "local", heldBack: true }],
        omittedEntries: 0,
        reviewDigest,
      },
    },
    providers: [],
  }
}

// Opens the launcher and asks it to create a session. The thread asks for the
// models too, so every pending models request is answered.
async function createFromLauncher() {
  const base = workspaceSnapshot()
  const snapshot = workspaceSnapshot({ machine: { ...base.machine, providers: [codex] } })
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "New session" }))
  await settle()
  // The launcher's code loads the first time it opens.
  await screen.findByLabelText("Session goal")
  const models = [{
    provider: "codex",
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description: "",
    supportedReasoningEfforts: ["medium" as const],
    defaultReasoningEffort: "medium" as const,
    isDefault: true,
  }]
  await act(async () => {
    while (sentRequests(socket, "runtime.models").some((request) => !socket.answered.has(request.id))) respond(socket, "runtime.models", models)
  })
  await settle()
  await user.type(screen.getByLabelText("Session goal"), "Rotate the staging keys")
  await user.click(screen.getByRole("button", { name: "Create session" }))
  await settle()
  return { socket, snapshot, user }
}

// Start a session from the launcher and have the daemon refuse it over a
// repository git filter.
async function refusedStart() {
  const { socket, snapshot, user } = await createFromLauncher()
  await act(async () => {
    fail(socket, "session.create", { code: repositoryGitFilterErrorCode, message: "This repository's own Git config sets the filter \"sops\".", data: refusal(snapshot) })
  })
  await settle()
  // The card's code loads on first use.
  await screen.findByRole("region", { name: "Domovoi did not start this session" })
  return { socket, snapshot, user }
}

it("draws the refusal card in the thread when the daemon refuses a new session over a git filter", async () => {
  const { snapshot } = await refusedStart()

  // The launcher closes: the refusal is the new session's thread, not a field error.
  expect(screen.queryByRole("dialog")).toBeNull()
  const card = screen.getByRole("region", { name: "Domovoi did not start this session" })
  expect(within(card).getByText(`Checking out acme-api would run the sops filter driver, which is not trusted on ${snapshot.machine.name}.`)).toBeTruthy()
  expect(within(card).getByText("Nothing from the repository ran.")).toBeTruthy()
})

// The card's code loads on first use, and its loading line takes focus while
// it does. Focus then lands on the card's heading, not on the document, so a
// keyboard or screen reader user meets the refusal (bot finding 4151622873).
it("moves focus to the refusal's heading once the card has loaded", async () => {
  await refusedStart()
  await settle()

  const heading = screen.getByRole("heading", { name: "Domovoi did not start this session" })
  await vi.waitFor(() => expect(document.activeElement).toBe(heading))
})

it("reviews and trusts from the refusal, then starts again only when asked", async () => {
  const { socket, snapshot, user } = await refusedStart()
  const card = screen.getByRole("region", { name: "Domovoi did not start this session" })

  await user.click(within(card).getByRole("button", { name: "Review and trust" }))
  await settle()
  await act(async () => { respond(socket, "tool.inventory", toolInventory(snapshot)) })
  await settle()
  const sheet = screen.getByRole("dialog")
  expect(within(sheet).getByRole("group", { name: ".git/config" })).toBeTruthy()
  await user.click(within(sheet).getByRole("button", { name: "Trust for this machine" }))
  await settle()

  // The grant acknowledges the git filters the sheet showed, by the review
  // digest tool.inventory gave, so the daemon runs them (#688).
  expect(sentRequests(socket, "repository.trust")[0]?.params).toEqual({
    projectId: snapshot.project!.id,
    configDigest: digest,
    client: "web",
    gitFilters: { reviewed: true, reviewDigest },
  })
  await act(async () => {
    respond(socket, "repository.trust", {
      outcome: "trusted",
      repository: {
        projectId: snapshot.project!.id,
        configDigest: digest,
        trust: { state: "trusted", trustedDigest: digest, trustedAt: "2026-09-30T10:41:00.000Z", trustedBy: { client: "web" } },
      },
    })
  })
  await settle()

  expect(within(card).getByText(`Trusted on ${snapshot.machine.name}. Nothing has started yet.`)).toBeTruthy()
  // Trust does not start the session (ruling Q202 A).
  expect(sentRequests(socket, "session.create")).toHaveLength(1)

  await user.click(within(card).getByRole("button", { name: "Start the session again" }))
  await settle()
  const [first, again] = sentRequests(socket, "session.create")
  expect(again?.params).toEqual(first?.params)
  await act(async () => { respond(socket, "session.create", snapshot) })
  await settle()
  expect(screen.queryByRole("region", { name: "Domovoi did not start this session" })).toBeNull()
})

it("shows the daemon's second refusal when the filters are still held back after trust, and offers the review again", async () => {
  const { socket, snapshot, user } = await refusedStart()
  const card = screen.getByRole("region", { name: "Domovoi did not start this session" })
  await user.click(within(card).getByRole("button", { name: "Review and trust" }))
  await settle()
  await act(async () => { respond(socket, "tool.inventory", toolInventory(snapshot)) })
  await settle()
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Trust for this machine" }))
  await settle()
  const trusted: RepositoryTrustState = { state: "trusted", trustedDigest: digest, trustedAt: "2026-09-30T10:41:00.000Z", trustedBy: { client: "web" } }
  await act(async () => {
    respond(socket, "repository.trust", { outcome: "trusted", repository: { projectId: snapshot.project!.id, configDigest: digest, trust: trusted } })
  })
  await settle()

  await user.click(within(card).getByRole("button", { name: "Start the session again" }))
  await settle()
  await act(async () => {
    fail(socket, "session.create", { code: repositoryGitFilterErrorCode, message: "refused", data: refusal(snapshot, trusted) })
  })
  await settle()

  const again = screen.getByRole("region", { name: "Domovoi did not start this session" })
  expect(within(again).getByText(`Checking out acme-api would run the sops filter driver. acme-api is trusted on ${snapshot.machine.name}, but its Git filters are held back until they are reviewed again.`)).toBeTruthy()
  expect(within(again).queryByRole("button", { name: "Start the session again" })).toBeNull()
  expect(within(again).getByRole("button", { name: "Review and trust again" })).toBeTruthy()
  // The card's code is loaded now; the new refusal still takes focus.
  await vi.waitFor(() => expect(document.activeElement).toBe(within(again).getByRole("heading", { name: "Domovoi did not start this session" })))
})

it("opens the Tools tab from the refusal", async () => {
  const { socket, user } = await refusedStart()

  await user.click(screen.getByRole("button", { name: "Open Tools" }))
  await settle()

  // The surface loads on first use.
  expect(await screen.findByRole("tab", { name: "Tools", selected: true })).toBeTruthy()
  await settle()
  expect(sentRequests(socket, "tool.inventory")).toHaveLength(1)
})

// A start belongs to the workspace it was made in. When the shell moves to
// another project before the refusal arrives, the refusal is dropped rather
// than drawn with the new project's name and offering its review (ruling Q323).
it("drops a refusal that arrives after the workspace moved to another project", async () => {
  const { socket, snapshot } = await createFromLauncher()
  const other = {
    ...snapshot,
    project: { ...snapshot.project!, id: "project-audit-other", name: "audit-other", path: "/Users/dev/src/audit-other" },
    sessions: snapshot.sessions.map((session) => ({ ...session, projectId: "project-audit-other" })),
  }
  await act(async () => { notify(socket, "workspace.changed", other) })
  await settle()

  await act(async () => {
    fail(socket, "session.create", { code: repositoryGitFilterErrorCode, message: "This repository's own Git config sets the filter \"sops\".", data: refusal(snapshot) })
  })
  await settle()
  // The card's code loads on first use: load it, so its absence is not a race.
  await act(async () => { await import("./session-refusal-card") })
  await settle()

  expect(screen.queryByRole("region", { name: "Domovoi did not start this session" })).toBeNull()
  expect(screen.queryByText(/Checking out audit-other/u)).toBeNull()
  expect(sentRequests(socket, "tool.inventory")).toHaveLength(0)
})

// Leaving the scope retires the start for good: coming back to the same
// project does not revive its refusal (ruling Q325).
it("drops a refusal after the workspace left its project and came back", async () => {
  const { socket, snapshot } = await createFromLauncher()
  const other = {
    ...snapshot,
    project: { ...snapshot.project!, id: "project-audit-other", name: "audit-other", path: "/Users/dev/src/audit-other" },
    sessions: snapshot.sessions.map((session) => ({ ...session, projectId: "project-audit-other" })),
  }
  await act(async () => { notify(socket, "workspace.changed", other) })
  await settle()
  await act(async () => { notify(socket, "workspace.changed", snapshot) })
  await settle()

  await act(async () => {
    fail(socket, "session.create", { code: repositoryGitFilterErrorCode, message: "This repository's own Git config sets the filter \"sops\".", data: refusal(snapshot) })
  })
  await settle()
  await act(async () => { await import("./session-refusal-card") })
  await settle()

  expect(screen.queryByRole("region", { name: "Domovoi did not start this session" })).toBeNull()
})

it("keeps any other failure in the launcher", async () => {
  const { socket } = await createFromLauncher()
  await act(async () => { fail(socket, "session.create", { code: -32603, message: "The worktree could not be created" }) })
  await settle()

  expect(within(screen.getByRole("dialog")).getByText("The worktree could not be created")).toBeTruthy()
  expect(screen.queryByRole("region", { name: "Domovoi did not start this session" })).toBeNull()
})
