import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import type { ProviderRuntime } from "@getdomovoi/protocol"

import { LauncherDialog } from "./workspace-shell.js"

afterEach(cleanup)

const providers: ProviderRuntime[] = [{
  id: "codex",
  command: "codex",
  status: "ready",
  sessionCapable: true,
  version: "1.0.0",
}]

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
  expect(items.some((text) => text.includes("aider") || text.includes("Not installed"))).toBe(false)
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
  expect(screen.getByText("No provider on this machine can start a session")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Execution provider" }))
  expect(screen.queryAllByRole("menuitem")).toHaveLength(0)
})
