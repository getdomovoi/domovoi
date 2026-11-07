import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  demoWorkspace,
  projectSwitchConfirmationErrorCode,
  type KnownProject,
  type Project,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import type { DesktopWindowBridge } from "./desktop-platform"
import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  fail,
  installFakeWebSocket,
  pendingRequest,
  respond,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocket,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

// Rulings Q158 A and Q159 A. Sessions are the unit and projects are where they
// run: opening another project changes where new sessions go, never which
// sessions are listed, and a session in another project is one click away
// through the switch rules that apply today. "Start a session" names its
// project and opens another one as part of the start.

let harness: FakeWebSocketHarness

beforeEach(() => {
  try {
    localStorage.removeItem(workspaceUiStorageKey)
  } catch {
    // A browser without storage starts from the default layout anyway.
  }
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

const projectA = demoWorkspace.project!
const projectB: Project = { id: "project-pdf-worker", machineId: demoWorkspace.machine.id, name: "pdf-worker", path: "/Users/dev/src/pdf-worker", branch: "main" }
const audit = demoWorkspace.sessions.find((session) => session.id === "session-audit")!

function known(project: Project, sessions: WorkspaceSnapshot["sessions"], folder: KnownProject["folder"] = "present"): KnownProject {
  return {
    project,
    savedAt: "2026-11-06T10:00:00.000Z",
    folder,
    sessions: sessions.map(({ id, title, state, updatedAt }) => ({ id, title, state, updatedAt })),
  }
}

// Project B open with no sessions, as the daemon answers after a switch.
function snapshotB(sessions: WorkspaceSnapshot["sessions"] = []) {
  return workspaceSnapshot({
    project: projectB,
    sessions,
    activeSessionId: sessions[0]?.id ?? null,
    approvals: [],
    thread: [],
    artifacts: [],
    workingPlans: [],
    annotations: [],
  })
}

const codex = { id: "codex", command: "codex", status: "ready" as const, sessionCapable: true, version: "1.0.0" }
const models = [{
  provider: "codex",
  id: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  description: "",
  supportedReasoningEfforts: ["medium" as const],
  defaultReasoningEffort: "medium" as const,
  isDefault: true,
}]

async function openShell(clientKind: "desktop" | "web" | "tablet" = "desktop", snapshot = workspaceSnapshot()) {
  render(<WorkspaceShell clientKind={clientKind} />)
  const socket = harness.socket(0)
  await act(async () => {
    completeHandshake(socket, { ...snapshot, machine: { ...snapshot.machine, providers: [codex] } })
  })
  await settle()
  return socket
}

async function answerProjectList(socket: FakeWebSocket, projects: KnownProject[]) {
  await settle()
  await act(async () => {
    respond(socket, "project.list", { projects })
  })
  await settle()
}

async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
  if (!screen.queryByRole("complementary", { name: "Sessions" })) {
    await user.click(screen.getByRole("button", { name: /^Sessions \d/ }))
  }
  return screen.getByRole("complementary", { name: "Sessions" })
}

const projectSection = (name: string) => screen.getByRole("region", { name: `Project ${name}` })

describe("the session sidebar across projects", () => {
  it("keeps the first project's sessions listed and labelled after another project opens", async () => {
    const user = userEvent.setup()
    const socket = await openShell()
    await answerProjectList(socket, [known(projectA, demoWorkspace.sessions)])
    await openDrawer(user)
    expect(within(projectSection("acme-api")).getByText(audit.title)).toBeTruthy()

    // Another client, or this one, opens pdf-worker. The snapshot now holds
    // pdf-worker and none of acme-api's sessions: the daemon keeps one
    // project active.
    await act(async () => {
      socket.receive({ jsonrpc: "2.0", method: "workspace.changed", params: snapshotB() })
    })
    await answerProjectList(socket, [known(projectB, []), known(projectA, demoWorkspace.sessions)])

    const drawer = screen.getByRole("complementary", { name: "Sessions" })
    const sections = within(drawer).getAllByRole("region").filter((region) => region.getAttribute("aria-label")?.startsWith("Project "))
    expect(sections.map((region) => region.getAttribute("aria-label"))).toEqual(["Project pdf-worker", "Project acme-api"])
    expect(within(projectSection("pdf-worker")).getByText("No sessions yet")).toBeTruthy()
    const acme = projectSection("acme-api")
    expect(within(acme).getByText("not active")).toBeTruthy()
    for (const session of demoWorkspace.sessions) expect(within(acme).getByText(session.title)).toBeTruthy()
  })

  // The list was read when acme-api opened; a session made since is only in
  // the snapshot. It must survive the switch, before the list is read again
  // and when that read fails.
  it("keeps a session made after the last list through the switch and a failed reread", async () => {
    const user = userEvent.setup()
    const socket = await openShell()
    await answerProjectList(socket, [known(projectA, demoWorkspace.sessions)])
    const fresh = { ...demoWorkspace.sessions[2]!, id: "session-fresh", title: "Fix the flaky upload test", updatedAt: "2026-11-06T11:00:00.000Z" }
    await act(async () => {
      socket.receive({ jsonrpc: "2.0", method: "workspace.changed", params: workspaceSnapshot({ sessions: [...demoWorkspace.sessions, fresh] }) })
    })
    await settle()
    await act(async () => {
      socket.receive({ jsonrpc: "2.0", method: "workspace.changed", params: snapshotB() })
    })
    await settle()
    await openDrawer(user)
    expect(within(projectSection("acme-api")).getByText("Fix the flaky upload test")).toBeTruthy()
    await act(async () => {
      fail(socket, "project.list", { code: -32603, message: "Domovoi hit an internal error" })
    })
    await settle()
    const acme = projectSection("acme-api")
    expect(within(acme).getByText("Fix the flaky upload test")).toBeTruthy()
    for (const session of demoWorkspace.sessions) expect(within(acme).getByText(session.title)).toBeTruthy()
  })

  // Ruling Q193 A: NEEDS YOU leads, across every project, so a waiting gate is
  // never inside a section below the fold; each project's section keeps its
  // RUNNING and QUIET. Two active projects is the J31 S2 shape, built here
  // from the snapshot alone.
  it("puts every project's waiting sessions in one NEEDS YOU above the project sections", async () => {
    const user = userEvent.setup()
    const waiting = { ...demoWorkspace.sessions[0]!, id: "session-pdf-gate", projectId: projectB.id, title: "Render Cyrillic invoices" }
    const gate = { ...demoWorkspace.approvals[0]!, id: "approval-pdf", sessionId: waiting.id }
    const socket = await openShell("desktop", workspaceSnapshot({
      projects: [projectA, projectB],
      sessions: [...demoWorkspace.sessions, waiting],
      approvals: [...demoWorkspace.approvals, gate],
    }))
    await answerProjectList(socket, [known(projectA, demoWorkspace.sessions), known(projectB, [waiting])])
    const drawer = await openDrawer(user)

    const regions = within(drawer).getAllByRole("region").map((region) => region.getAttribute("aria-label"))
    expect(regions.indexOf("NEEDS YOU")).toBe(0)
    expect(regions.filter((label) => label?.startsWith("Project "))).toEqual(["Project acme-api", "Project pdf-worker"])
    const needsYou = within(drawer).getAllByRole("region", { name: "NEEDS YOU" })
    expect(needsYou).toHaveLength(1)
    const rows = within(needsYou[0]!).getAllByRole("button", { name: /waiting on you/ })
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("acme-api · waiting on you"),
      expect.stringContaining("pdf-worker · waiting on you"),
    ])
    // Both of pdf-worker's sessions wait on you, so its section says where they are.
    expect(within(projectSection("pdf-worker")).getByText("Its one session is in Needs you")).toBeTruthy()
    expect(within(projectSection("acme-api")).getByRole("region", { name: "QUIET" })).toBeTruthy()
  })

  it("opens the other project and its session when one of its sessions is chosen", async () => {
    const user = userEvent.setup()
    const socket = await openShell("desktop", snapshotB())
    await answerProjectList(socket, [known(projectB, []), known(projectA, demoWorkspace.sessions)])
    await openDrawer(user)

    await user.click(within(projectSection("acme-api")).getByRole("button", { name: new RegExp(`^${audit.title.slice(0, 20)}`) }))
    await settle()
    expect(pendingRequest(socket, "project.open").params).toMatchObject({ path: projectA.path })
    await act(async () => {
      respond(socket, "project.open", workspaceSnapshot())
    })
    await settle()
    expect(pendingRequest(socket, "session.activate").params).toMatchObject({ sessionId: audit.id })
  })

  it("asks before stopping the open project's work when it has sessions, then opens the session", async () => {
    const user = userEvent.setup()
    const running = { ...demoWorkspace.sessions[1]!, id: "session-pdf", projectId: projectB.id, title: "Render Cyrillic invoices" }
    const socket = await openShell("desktop", snapshotB([running]))
    await answerProjectList(socket, [known(projectB, [running]), known(projectA, demoWorkspace.sessions)])
    await openDrawer(user)

    await user.click(within(projectSection("acme-api")).getByRole("button", { name: new RegExp(`^${audit.title.slice(0, 20)}`) }))
    await settle()
    const confirmation = {
      kind: "project-switch-confirmation" as const,
      requestedPath: projectA.path,
      sessions: [{ id: running.id, title: running.title, state: running.state }],
      sessionCount: 1,
      worktreeCount: 0,
    }
    await act(async () => {
      fail(socket, "project.open", { code: projectSwitchConfirmationErrorCode, message: "Confirm stopping this project's running work before switching", data: confirmation })
    })
    await settle()
    expect(sentRequests(socket, "session.activate")).toHaveLength(0)
    const ask = screen.getByRole("alertdialog", { name: "Stop running work and switch projects?" })
    await user.click(within(ask).getByRole("button", { name: "Stop work and switch" }))
    await settle()
    expect(pendingRequest(socket, "project.open").params).toMatchObject({ path: projectA.path, confirmation })
    await act(async () => {
      respond(socket, "project.open", workspaceSnapshot())
    })
    await settle()
    expect(pendingRequest(socket, "session.activate").params).toMatchObject({ sessionId: audit.id })
  })

  it("offers a New session in each project, with that project chosen", async () => {
    const user = userEvent.setup()
    const socket = await openShell()
    await answerProjectList(socket, [known(projectA, demoWorkspace.sessions), known(projectB, [])])
    await openDrawer(user)

    await user.click(screen.getByRole("button", { name: "New session in pdf-worker" }))
    await settle()
    const dialog = await screen.findByRole("dialog", { name: "Start a session" })
    expect(within(dialog).getByRole("button", { name: /^Project/ }).textContent).toContain("pdf-worker")
  })

  // A project that is not active answers nothing until it opens, so its rows
  // stay in its own section (the design's NEEDS YOU holds active work only),
  // but each says how its session was left.
  it("says how each session in a project that is not active was left", async () => {
    const user = userEvent.setup()
    const socket = await openShell()
    const left = [
      { ...audit, id: "session-conflict", title: "Conflicted move", state: "ownership-conflict" as const },
      { ...audit, id: "session-failed", title: "Failed upgrade", state: "failed" as const },
      { ...audit, id: "session-moved", title: "Moved away", state: "transferred" as const },
    ]
    await answerProjectList(socket, [known(projectA, demoWorkspace.sessions), known(projectB, left)])
    await openDrawer(user)
    const section = projectSection("pdf-worker")
    const meta = (title: string) => within(section).getByRole("button", { name: new RegExp(`^${title}`) }).textContent
    expect(meta("Conflicted move")).toContain("ownership conflict")
    expect(meta("Failed upgrade")).toMatch(/failed .* ago/)
    expect(meta("Moved away")).toContain("moved to another machine")
  })

  it("lists a project whose folder is gone and says so", async () => {
    const user = userEvent.setup()
    const socket = await openShell()
    await answerProjectList(socket, [known(projectA, demoWorkspace.sessions), known(projectB, [], "missing")])
    await openDrawer(user)
    const section = projectSection("pdf-worker")
    expect(within(section).getByText("folder not found")).toBeTruthy()
    const start = within(section).getByRole<HTMLButtonElement>("button", { name: "New session in pdf-worker" })
    expect(start.disabled).toBe(true)
    expect(start.getAttribute("aria-describedby")).toBeTruthy()
  })

  it("never asks a phone or tablet credential for the project list", async () => {
    await openShell("tablet")
    await settle()
    expect(sentRequests(harness.socket(0), "project.list")).toHaveLength(0)
  })
})

describe("starting a session in another project", () => {
  async function startIn(user: ReturnType<typeof userEvent.setup>, socket: FakeWebSocket, project: string) {
    await user.click(screen.getByRole("button", { name: "New session" }))
    const dialog = await screen.findByRole("dialog", { name: "Start a session" })
    await settle()
    await act(async () => {
      while (sentRequests(socket, "runtime.models").some((request) => !socket.answered.has(request.id))) respond(socket, "runtime.models", models)
    })
    await settle()
    await user.click(within(dialog).getByRole("button", { name: /^Project/ }))
    await user.click(screen.getByRole("menuitem", { name: new RegExp(project) }))
    await user.type(within(dialog).getByLabelText("Session goal"), "Render Cyrillic invoices")
    await user.click(within(dialog).getByRole("button", { name: "Create session" }))
    await settle()
    return dialog
  }

  const confirmation = {
    kind: "project-switch-confirmation" as const,
    requestedPath: projectB.path,
    sessions: demoWorkspace.sessions.map(({ id, title, state }) => ({ id, title, state })),
    sessionCount: demoWorkspace.sessions.length,
    worktreeCount: 0,
  }

  it("opens the project through the switch confirmation, then creates the session there", async () => {
    const user = userEvent.setup()
    const socket = await openShell()
    await answerProjectList(socket, [known(projectA, demoWorkspace.sessions), known(projectB, [])])
    await startIn(user, socket, "pdf-worker")

    expect(pendingRequest(socket, "project.open").params).toMatchObject({ path: projectB.path })
    await act(async () => {
      fail(socket, "project.open", { code: projectSwitchConfirmationErrorCode, message: "Confirm stopping this project's running work before switching", data: confirmation })
    })
    await settle()
    expect(sentRequests(socket, "session.create")).toHaveLength(0)
    await user.click(screen.getByRole("button", { name: "Stop work and switch" }))
    await settle()
    expect(pendingRequest(socket, "project.open").params).toMatchObject({ path: projectB.path, confirmation })
    await act(async () => {
      respond(socket, "project.open", snapshotB())
    })
    await settle()
    // The create names the project that was opened, so a switch another
    // client makes in between is refused by the daemon rather than starting
    // the session in the wrong repository.
    expect(pendingRequest(socket, "session.create").params).toMatchObject({ title: "Render Cyrillic invoices", projectId: projectB.id })
  })

  it("starts nothing and keeps the launcher open when the switch is not confirmed", async () => {
    const user = userEvent.setup()
    const socket = await openShell()
    await answerProjectList(socket, [known(projectA, demoWorkspace.sessions), known(projectB, [])])
    const dialog = await startIn(user, socket, "pdf-worker")
    await act(async () => {
      fail(socket, "project.open", { code: projectSwitchConfirmationErrorCode, message: "Confirm stopping this project's running work before switching", data: confirmation })
    })
    await settle()
    await user.click(screen.getByRole("button", { name: "Keep current project" }))
    await settle()
    expect(sentRequests(socket, "session.create")).toHaveLength(0)
    expect(sentRequests(socket, "project.open")).toHaveLength(1)
    expect(dialog.isConnected).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Create session" }).disabled).toBe(false)
  })

  it("takes Choose a folder from the desktop's own folder dialog", async () => {
    const user = userEvent.setup()
    const openDirectory = vi.fn(async () => ({ status: "selected" as const, path: "/Users/dev/src/new-repo" }))
    const windowBridge: DesktopWindowBridge = {
      platform: "darwin",
      getRpcEndpoint: async () => ({ url: "ws://127.0.0.1:47831/rpc", token: "t" }),
      captureAnnotation: async () => { throw new Error("not in this test") },
      notify: async () => true,
      onNotificationActivate: () => () => {},
      openDirectory,
      readClipboardText: async () => "",
      writeClipboardText: async () => true,
      openExternal: async () => true,
      onDeepLink: () => () => {},
      getWindowDecoration: async () => "system",
      setWindowDecoration: async () => true,
      minimize: () => {},
      maximize: () => {},
      close: () => {},
    }
    render(<WorkspaceShell windowBridge={windowBridge} />)
    const socket = harness.socket(0)
    await act(async () => {
      const snapshot = workspaceSnapshot()
      completeHandshake(socket, { ...snapshot, machine: { ...snapshot.machine, providers: [codex] } })
    })
    await answerProjectList(socket, [known(projectA, demoWorkspace.sessions)])
    await user.click(screen.getByRole("button", { name: "New session" }))
    const dialog = await screen.findByRole("dialog", { name: "Start a session" })
    await settle()
    await user.click(within(dialog).getByRole("button", { name: /^Project/ }))
    await user.click(screen.getByRole("menuitem", { name: /Choose a folder/ }))
    await settle()
    expect(openDirectory).toHaveBeenCalledOnce()
    expect(within(dialog).getByRole("button", { name: /^Project/ }).textContent).toContain("new-repo")
    expect(within(dialog).queryByLabelText("Repository path")).toBeNull()
  })

  it("opens the same dialog with no project chosen when none is open", async () => {
    const user = userEvent.setup()
    const socket = await openShell("desktop", workspaceSnapshot({ project: null, sessions: [], activeSessionId: null, approvals: [], thread: [], artifacts: [], workingPlans: [], annotations: [], approvalRules: [] }))
    await answerProjectList(socket, [known(projectB, [])])
    await user.click(screen.getByRole("button", { name: "New session" }))
    const dialog = await screen.findByRole("dialog", { name: "Start a session" })
    expect(screen.queryByRole("dialog", { name: "Open a project" })).toBeNull()
    expect(within(dialog).getByRole("button", { name: /^Project/ }).textContent).toContain("Choose a project")
    await user.type(within(dialog).getByLabelText("Session goal"), "Render Cyrillic invoices")
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Create session" }).disabled).toBe(true)
  })
})
