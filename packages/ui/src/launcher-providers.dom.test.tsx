import { cleanup, render, screen, waitFor } from "@testing-library/react"
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
