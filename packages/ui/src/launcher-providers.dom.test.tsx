import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { demoWorkspace, type ProviderRuntime } from "@getdomovoi/protocol"

import { LauncherDialog } from "./workspace-shell.js"

afterEach(cleanup)

const providers: ProviderRuntime[] = [{
  id: "codex",
  command: "codex",
  status: "ready",
  sessionCapable: true,
  version: "1.0.0",
}]

it("offers recent sessions below the new-session prompt", async () => {
  const user = userEvent.setup()
  const onResumeSession = vi.fn()
  render(<LauncherDialog
    mode="session"
    defaultProviderId="codex"
    defaultPermissionMode="build"
    onOpenChange={vi.fn()}
    onOpenProject={vi.fn(async () => {})}
    onCreateSession={vi.fn(async () => {})}
    onListModels={vi.fn(async () => [])}
    providers={providers}
    recentSessions={demoWorkspace.sessions}
    onResumeSession={onResumeSession}
  />)
  expect(screen.getByText("PICK UP WHERE YOU LEFT OFF")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: /Migrate billing webhooks/ }))
  expect(onResumeSession).toHaveBeenCalledWith(demoWorkspace.sessions[0]!.id)
})

it("keeps the chosen model when an equivalent provider list arrives", async () => {
  const onListModels = vi.fn(async () => [{
    provider: "codex",
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description: "",
    supportedReasoningEfforts: ["medium" as const],
    defaultReasoningEffort: "medium" as const,
    isDefault: true,
  }])
  const props = {
    mode: "session" as const,
    defaultProviderId: "codex",
    defaultPermissionMode: "build" as const,
    onOpenChange: vi.fn(),
    onOpenProject: vi.fn(async () => {}),
    onCreateSession: vi.fn(async () => {}),
    onListModels,
  }
  const view = render(<LauncherDialog {...props} providers={providers} />)
  await waitFor(() => expect(onListModels).toHaveBeenCalledTimes(1))
  await screen.findByText("GPT-5.6 Sol")

  // A snapshot delivers an equal-but-new array on every update.
  view.rerender(<LauncherDialog {...props} providers={providers.map((provider) => ({ ...provider }))} />)

  await waitFor(() => expect(onListModels).toHaveBeenCalledTimes(1))
})

// A harness that is not installed is absent from the picker, not a greyed
// item: a disabled row that can never be chosen is a dead control. One that
// needs a sign-in is installed and yours, and stays listed with its reason.
it("lists only the harnesses that reported in the provider picker", async () => {
  const user = userEvent.setup()
  const onListModels = vi.fn(async () => [])
  render(
    <LauncherDialog
      mode="session"
      defaultProviderId="codex"
      defaultPermissionMode="build"
      onOpenChange={vi.fn()}
      onOpenProject={vi.fn(async () => {})}
      onCreateSession={vi.fn(async () => {})}
      onListModels={onListModels}
      providers={[
        ...providers,
        { id: "claude-code", command: "claude", status: "auth-required", sessionCapable: true },
        { id: "aider", command: "aider", status: "missing", sessionCapable: true },
      ]}
    />,
  )
  await user.click(screen.getByRole("button", { name: "Execution provider" }))
  const items = screen.getAllByRole("menuitem").map((item) => item.textContent ?? "")
  expect(items.some((text) => text.includes("Codex"))).toBe(true)
  expect(items.some((text) => text.includes("Claude Code") && text.includes("Sign in required"))).toBe(true)
  expect(items.some((text) => text.includes("aider") || text.includes("Not found"))).toBe(false)
})

// The runtime keeps the default provider's id when nothing can start, so the
// trigger reads from the same list as the picker and says so, rather than
// naming a harness the picker cannot show.
it("says no provider is available when the default harness is not installed, instead of naming it", async () => {
  const user = userEvent.setup()
  render(
    <LauncherDialog
      mode="session"
      defaultProviderId="codex"
      defaultPermissionMode="build"
      onOpenChange={vi.fn()}
      onOpenProject={vi.fn(async () => {})}
      onCreateSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])}
      providers={[{ id: "codex", command: "codex", status: "missing", sessionCapable: true }]}
    />,
  )
  expect(screen.getByRole("button", { name: "Execution provider" }).textContent).toContain("No provider available")
  expect(screen.getByText("Domovoi found no provider CLI on the path it searched")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Execution provider" }))
  expect(screen.queryAllByRole("menuitem")).toHaveLength(0)
})

// A search that finds nothing is not proof of absence: the daemon may have
// looked on a PATH the person's shell never sees. The empty state is a search
// report: what was looked for, where, and what would change the answer. It is
// not the greyed-out picker the launcher ruling removed, and not a status
// list either.
it("reports what it searched for and where when every harness is missing", () => {
  render(
    <LauncherDialog
      mode="session"
      defaultProviderId="codex"
      defaultPermissionMode="build"
      onOpenChange={vi.fn()}
      onOpenProject={vi.fn(async () => {})}
      onCreateSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])}
      providers={[
        { id: "claude-code", command: "claude", status: "missing", sessionCapable: true },
        { id: "codex", command: "codex", status: "missing", sessionCapable: true },
      ]}
      toolPath="/usr/bin:/bin:/usr/sbin:/sbin"
    />,
  )
  const report = screen.getByRole("region", { name: "Provider search" })
  expect(report.textContent).toContain("Searched /usr/bin:/bin:/usr/sbin:/sbin for claude and codex and found neither.")
  expect(report.textContent).toContain("Finding nothing here is not proof nothing is installed")
  expect(report.textContent).toContain("tools.json")
  expect(screen.queryByRole("list", { name: "Provider readiness" })).toBeNull()
  expect(screen.queryByText("Not installed")).toBeNull()
})

it("says the path was not reported when the daemon predates the search record", () => {
  render(
    <LauncherDialog
      mode="session"
      defaultProviderId="codex"
      defaultPermissionMode="build"
      onOpenChange={vi.fn()}
      onOpenProject={vi.fn(async () => {})}
      onCreateSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])}
      providers={[{ id: "codex", command: "codex", status: "missing", sessionCapable: true }]}
    />,
  )
  const report = screen.getByRole("region", { name: "Provider search" })
  expect(report.textContent).toContain("Searched for codex and found nothing. This daemon did not report where it looked.")
})
