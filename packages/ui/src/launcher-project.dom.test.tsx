import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ProviderModel, ProviderRuntime } from "@getdomovoi/protocol"

import { LauncherDialog } from "./launcher-dialog.js"
import type { LauncherProject } from "./project-entries.js"

afterEach(cleanup)

// Rulings Q158 A: "Start a session" names the project the session starts in.
// It defaults to the open project, lists the projects this machine knows, and
// takes a folder; choosing another project opens it as part of the start.

const providers: ProviderRuntime[] = [{ id: "codex", command: "codex", status: "ready", sessionCapable: true, version: "1.0.0" }]
const models: ProviderModel[] = [{
  provider: "codex",
  id: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  description: "",
  supportedReasoningEfforts: ["medium"],
  defaultReasoningEffort: "medium",
  isDefault: true,
}]

const acme: LauncherProject = { name: "acme-api", path: "/Users/dev/src/acme-api", open: true, folder: "present" }
const pdf: LauncherProject = { name: "pdf-worker", path: "/Users/dev/src/pdf-worker", open: false, folder: "present" }
const gone: LauncherProject = { name: "old-site", path: "/Users/dev/src/old-site", open: false, folder: "missing" }

function launcher(overrides: Partial<Parameters<typeof LauncherDialog>[0]> = {}) {
  const onCreateSession = vi.fn(async () => "started" as const)
  const props: Parameters<typeof LauncherDialog>[0] = {
    mode: "session",
    defaultProviderId: "codex",
    defaultPermissionMode: "build",
    onOpenChange: vi.fn(),
    onOpenProject: vi.fn(async () => {}),
    onCreateSession,
    onListModels: vi.fn(async () => models),
    providers,
    projects: [acme, pdf, gone],
    ...overrides,
  }
  render(<LauncherDialog {...props} />)
  return { props, onCreateSession: props.onCreateSession as typeof onCreateSession }
}

const projectField = () => screen.getByRole("button", { name: /^Project/ })
const goal = () => screen.getByLabelText("Session goal")
const start = () => screen.getByRole<HTMLButtonElement>("button", { name: "Create session" })

describe("the project a session starts in", () => {
  it("sits above the goal and defaults to the open project", async () => {
    const user = userEvent.setup()
    const { onCreateSession } = launcher()
    const field = projectField()
    expect(field.textContent).toContain("acme-api")
    expect(field.compareDocumentPosition(goal()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await screen.findByText("GPT-5.6 Sol")
    await user.type(goal(), "Fix the font fallback")
    await user.click(start())
    expect(onCreateSession).toHaveBeenCalledWith("Fix the font fallback", expect.objectContaining({ provider: "codex", model: "gpt-5.6-sol" }), acme.path)
  })

  it("lists the known projects, says which is open, and starts in the one picked", async () => {
    const user = userEvent.setup()
    const { onCreateSession, props } = launcher()
    await user.click(projectField())
    const items = screen.getAllByRole("menuitem")
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("acme-api"),
      expect.stringContaining("pdf-worker"),
      expect.stringContaining("old-site"),
      expect.stringContaining("Choose a folder"),
    ])
    expect(items[0]!.textContent).toContain("open")
    expect(items[1]!.textContent).toContain("not active")
    expect(items[2]!.textContent).toContain("folder not found")
    expect(items[2]!.getAttribute("aria-disabled")).toBe("true")

    await user.click(items[1]!)
    expect(projectField().textContent).toContain("pdf-worker")
    expect(screen.getByText("Domovoi opens this project first. If the open project has sessions, it asks before stopping their work.")).toBeTruthy()
    await screen.findByText("GPT-5.6 Sol")
    await user.type(goal(), "Render Cyrillic invoices")
    await user.click(start())
    expect(onCreateSession).toHaveBeenCalledWith("Render Cyrillic invoices", expect.anything(), pdf.path)
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("starts with the project it was opened for", async () => {
    launcher({ initialProjectPath: pdf.path })
    expect(projectField().textContent).toContain("pdf-worker")
  })

  it("takes a folder from the desktop picker", async () => {
    const user = userEvent.setup()
    const onChooseFolder = vi.fn(async () => "/Users/dev/src/new-repo")
    const { onCreateSession } = launcher({ onChooseFolder })
    await user.click(projectField())
    await user.click(screen.getByRole("menuitem", { name: /Choose a folder/ }))
    await waitFor(() => expect(projectField().textContent).toContain("new-repo"))
    expect(onChooseFolder).toHaveBeenCalledOnce()
    await screen.findByText("GPT-5.6 Sol")
    await user.type(goal(), "Set up the repository")
    await user.click(start())
    expect(onCreateSession).toHaveBeenCalledWith("Set up the repository", expect.anything(), "/Users/dev/src/new-repo")
  })

  it("keeps the project when the desktop picker is cancelled", async () => {
    const user = userEvent.setup()
    launcher({ onChooseFolder: vi.fn(async () => null) })
    await user.click(projectField())
    await user.click(screen.getByRole("menuitem", { name: /Choose a folder/ }))
    await waitFor(() => expect(projectField().textContent).toContain("acme-api"))
  })

  it("takes a typed path where there is no folder picker", async () => {
    const user = userEvent.setup()
    const { onCreateSession } = launcher()
    await user.click(projectField())
    await user.click(screen.getByRole("menuitem", { name: /Choose a folder/ }))
    const path = screen.getByLabelText("Repository path")
    expect(screen.getByText("The daemon validates the repository before opening it.")).toBeTruthy()
    await screen.findByText("GPT-5.6 Sol")
    await user.type(goal(), "Set up the repository")
    expect(start().disabled).toBe(true)
    await user.type(path, "/srv/repos/billing")
    expect(start().disabled).toBe(false)
    await user.click(start())
    expect(onCreateSession).toHaveBeenCalledWith("Set up the repository", expect.anything(), "/srv/repos/billing")
  })

  it("leaves the project empty and Create session off until one is chosen when none is open", async () => {
    const user = userEvent.setup()
    const { onCreateSession } = launcher({ projects: [{ ...pdf }] })
    expect(projectField().textContent).toContain("Choose a project")
    await screen.findByText("GPT-5.6 Sol")
    await user.type(goal(), "Render Cyrillic invoices")
    expect(start().disabled).toBe(true)
    await user.click(projectField())
    await user.click(screen.getByRole("menuitem", { name: /pdf-worker/ }))
    expect(start().disabled).toBe(false)
    await user.click(start())
    expect(onCreateSession).toHaveBeenCalledWith("Render Cyrillic invoices", expect.anything(), pdf.path)
  })

  it("stays open when the switch it needed was not confirmed", async () => {
    const user = userEvent.setup()
    const onCreateSession = vi.fn(async () => "cancelled" as const)
    const { props } = launcher({ onCreateSession, initialProjectPath: pdf.path })
    await screen.findByText("GPT-5.6 Sol")
    await user.type(goal(), "Render Cyrillic invoices")
    await user.click(start())
    expect(onCreateSession).toHaveBeenCalledOnce()
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false)
    const dialog = screen.getByRole("dialog", { name: "Start a session" })
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Create session" }).disabled).toBe(false)
  })
})
