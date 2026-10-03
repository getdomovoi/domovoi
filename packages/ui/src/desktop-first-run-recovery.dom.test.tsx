import type { ProviderRuntime, SessionSummary } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { FirstRunAgents } from "./desktop-first-run.js"

afterEach(cleanup)

const provider: ProviderRuntime = {
  id: "codex",
  command: "codex",
  status: "ready",
  version: "0.149.0",
  sessionCapable: true,
}

const renderAgents = (
  overrides: Partial<Parameters<typeof FirstRunAgents>[0]> = {},
) => {
  const handlers = {
    onRetry: vi.fn(),
    onCopyGuidance: vi.fn(),
  }
  render(
    <FirstRunAgents
      connected={false}
      providers={[provider]}
      sessions={[] as readonly SessionSummary[]}
      refreshing={false}
      recoveryError=""
      {...handlers}
      {...overrides}
    />,
  )
  return handlers
}

describe("FirstRunAgents recovery interaction", () => {
  it("says the daemon has not answered and retries when the operator asks", async () => {
    const user = userEvent.setup()
    const handlers = renderAgents()

    expect(screen.getByText("Waiting for a verified response from the local daemon.")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Retry diagnostics" }))

    expect(handlers.onRetry).toHaveBeenCalledTimes(1)
  })

  it("blocks a second retry while a refresh is already in flight", async () => {
    const user = userEvent.setup()
    const handlers = renderAgents({ refreshing: true })

    const retrying = screen.getByRole("button", { name: "Refreshing" }) as HTMLButtonElement
    expect(retrying.disabled).toBe(true)

    await user.click(retrying)
    expect(handlers.onRetry).not.toHaveBeenCalled()
  })

  it("hands the provider sign-in command to the copy handler", async () => {
    const user = userEvent.setup()
    const handlers = renderAgents({
      connected: true,
      providers: [{ ...provider, status: "auth-required" }],
    })

    await user.click(screen.getByRole("button", { name: /copy sign-in command/i }))

    expect(handlers.onCopyGuidance).toHaveBeenCalledWith("codex login")
  })

  it("names a diagnostics refresh that failed", () => {
    renderAgents({ connected: true, recoveryError: "connect ECONNREFUSED 127.0.0.1:47831" })
    expect(screen.getByText("Diagnostics could not be refreshed")).toBeTruthy()
    expect(screen.getByText("connect ECONNREFUSED 127.0.0.1:47831")).toBeTruthy()
  })
})
