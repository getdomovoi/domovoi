import type { ProviderRuntime, SessionSummary } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { FirstRunSetupSteps } from "./desktop-first-run.js"

afterEach(cleanup)

const provider: ProviderRuntime = {
  id: "codex",
  command: "codex",
  status: "ready",
  version: "0.149.0",
  sessionCapable: true,
}

const renderSteps = (
  overrides: Partial<Parameters<typeof FirstRunSetupSteps>[0]> = {},
) => {
  const handlers = {
    onProviderChange: vi.fn(),
    onPermissionModeChange: vi.fn(),
    onRetry: vi.fn(),
    onCopyGuidance: vi.fn(),
  }
  render(
    <FirstRunSetupSteps
      connected={false}
      providers={[provider]}
      sessions={[] as readonly SessionSummary[]}
      selectedProviderId="codex"
      permissionMode="build"
      refreshing={false}
      recoveryError=""
      {...handlers}
      {...overrides}
    />,
  )
  return handlers
}

const retryButton = () => screen.getByRole("button", { name: /^retry$/i }) as HTMLButtonElement

describe("FirstRunSetupSteps recovery interaction", () => {
  it("retries daemon diagnostics when the operator clicks Retry", async () => {
    const user = userEvent.setup()
    const handlers = renderSteps()

    await user.click(retryButton())

    expect(handlers.onRetry).toHaveBeenCalledTimes(1)
  })

  it("blocks a second retry while a refresh is already in flight", async () => {
    const user = userEvent.setup()
    const handlers = renderSteps({ refreshing: true })

    const retrying = screen.getByRole("button", { name: /retrying/i }) as HTMLButtonElement
    expect(retrying.disabled).toBe(true)

    await user.click(retrying)
    expect(handlers.onRetry).not.toHaveBeenCalled()
  })

  it("hands the provider sign-in command to the copy handler", async () => {
    const user = userEvent.setup()
    const handlers = renderSteps({
      connected: true,
      providers: [{ ...provider, status: "auth-required" }],
    })

    await user.click(screen.getByRole("button", { name: /copy sign-in command/i }))

    expect(handlers.onCopyGuidance).toHaveBeenCalledTimes(1)
    expect(handlers.onCopyGuidance.mock.calls[0]?.[0]).toContain("codex")
  })
})
