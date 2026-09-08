import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"

import { PolicyRefusalCard, type PolicyRefusal } from "./policy-refusal-card"

afterEach(cleanup)

const refusal: PolicyRefusal = {
  operation: "Deploy the billing service to production",
  command: "pnpm -w deploy --env production",
  rule: "No deploys from an agent turn",
  setBy: "acme-eng owner, 2026-08-14",
  scope: "every machine in acme-eng",
  remedy: "Run it yourself from the deploy runbook, or ask an owner to retire the rule.",
}

it("offers no decision, because no client decision can permit it", () => {
  render(<PolicyRefusalCard refusal={refusal} />)
  expect(screen.queryAllByRole("button")).toHaveLength(0)
  for (const label of [/allow/i, /approve/i, /always/i]) {
    expect(screen.queryByText(label)).toBeNull()
  }
})

it("names the rule, who set it and how far it reaches", () => {
  render(<PolicyRefusalCard refusal={refusal} />)
  expect(screen.getByText(refusal.rule)).toBeTruthy()
  expect(screen.getByText(refusal.setBy)).toBeTruthy()
  expect(screen.getByText(refusal.scope)).toBeTruthy()
})

it("says plainly that approval would not help", () => {
  render(<PolicyRefusalCard refusal={refusal} />)
  expect(screen.getByText(/there is no\s+override/i)).toBeTruthy()
})

it("says what to do instead", () => {
  render(<PolicyRefusalCard refusal={refusal} />)
  expect(screen.getByText(refusal.remedy)).toBeTruthy()
})

it("does not dress a refusal as a waiting gate", () => {
  const { container } = render(<PolicyRefusalCard refusal={refusal} />)
  // Amber is reserved for a gate that is waiting on a person. Nobody is
  // waiting here, so no warn token may appear.
  expect(container.innerHTML).not.toMatch(/warn|warning/)
})
