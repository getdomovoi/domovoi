import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it } from "vitest"

import type { SessionUsage } from "@getdomovoi/protocol"

import { SessionUsageSummary } from "./workspace-shell.js"

afterEach(cleanup)

function usage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    sessionId: "session-1",
    inputTokens: 900,
    cachedInputTokens: 100,
    outputTokens: 300,
    reasoningTokens: 0,
    totalTokens: 1200,
    costMicros: 4500,
    currency: "USD",
    reportedCostTurns: 3,
    unavailableCostTurns: 0,
    byRuntime: [{
      provider: "codex",
      model: "gpt-5.6-sol",
      inputTokens: 900,
      cachedInputTokens: 100,
      outputTokens: 300,
      reasoningTokens: 0,
      totalTokens: 1200,
      costMicros: 4500,
      currency: "USD",
      turns: 3,
    }],
    ...overrides,
  }
}

it("shows total tokens in the session header", () => {
  render(<SessionUsageSummary usage={usage()} />)

  expect(screen.getByRole("button", { name: /1\.2k tokens/u }).textContent).toContain("$0.0045")
})

it("never shows a cost the provider did not report", () => {
  render(<SessionUsageSummary usage={usage({ reportedCostTurns: 0, unavailableCostTurns: 4, costMicros: 0, currency: undefined })} />)

  const trigger = screen.getByRole("button", { name: /1\.2k tokens/u })
  expect(trigger.textContent).not.toContain("$")
  expect(trigger.textContent).toMatch(/cost unavailable/iu)
})

it("names the turns that reported no cost in the breakdown", async () => {
  render(<SessionUsageSummary usage={usage({ reportedCostTurns: 2, unavailableCostTurns: 1 })} />)

  await userEvent.click(screen.getByRole("button", { name: /1\.2k tokens/u }))

  expect(screen.getByText(/1 turn reported no cost/u)).toBeTruthy()
  expect(screen.getByText(/gpt-5\.6-sol/u)).toBeTruthy()
})

it("renders nothing before the daemon has answered", () => {
  const view = render(<SessionUsageSummary usage={null} />)
  expect(view.container.textContent).toBe("")
})

it("stays quiet for a session with no recorded turns", () => {
  const view = render(
    <SessionUsageSummary
      usage={usage({ totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reportedCostTurns: 0, unavailableCostTurns: 0, costMicros: 0, currency: undefined, byRuntime: [] })}
    />,
  )
  expect(view.container.textContent).toBe("")
})
