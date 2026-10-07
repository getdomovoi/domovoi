import { demoWorkspace } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import { type ComponentProps } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { PolicyRefusalCard, type PolicyRefusal } from "./policy-refusal-card"
import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

const refusal: PolicyRefusal = {
  operation: "Deploy the billing service to production",
  command: "pnpm -w deploy --env production",
  rule: "No deploys from an agent turn",
  setBy: "acme-eng owner, 2026-08-14",
  scope: "every machine in acme-eng",
  remedy: "Run it yourself from the deploy runbook, or ask an owner to retire the rule.",
}

it("renders daemon policy refusals in the active thread without approval controls", () => {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  snapshot.thread.push({
    id: "policy-refusal-1",
    sessionId: snapshot.activeSessionId!,
    kind: "policy-refusal",
    ...refusal,
    createdAt: "2026-09-19T20:00:00.000Z",
  })
  const props: ComponentProps<typeof Thread> = {
    snapshot,
    connected: true,
    onQueuedChange: vi.fn(),
    onResolve: vi.fn(async () => {}),
    onSetRuntime: vi.fn(async () => {}),
    onForkSession: vi.fn(async () => {}),
    onListModels: vi.fn(async () => []),
    onNewSession: vi.fn(),
    onSend: vi.fn(async () => {}),
    onCheckpoint: vi.fn(async () => {}),
    onRestoreCheckpoint: vi.fn(async () => {}),
    onPauseSession: vi.fn(async () => {}),
  }
  render(<Thread {...props} />)
  expect(screen.getByRole("region", { name: "Policy refusal" })).toBeTruthy()
  expect(screen.getByText(refusal.rule)).toBeTruthy()
  expect(screen.queryByRole("button", { name: /allow|approve/i })).toBeNull()
})

it("offers no decision, because no client decision can permit it", () => {
  render(<PolicyRefusalCard refusal={refusal} />)
  expect(screen.queryAllByRole("button")).toHaveLength(0)
  // Anchored: the drawn header itself says there is nothing to approve, and
  // what must be absent is anything that reads as a decision's label.
  for (const label of [/^\s*allow/i, /^\s*approve/i, /^\s*always/i]) {
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

// S3.10h: the drawn card. The header says there is nothing to approve, the
// rule it broke heads its own block with who set it and where it applies,
// and the remedy sits under What you can do instead.
it("heads the card with nothing to approve", () => {
  render(<PolicyRefusalCard refusal={refusal} />)
  expect(screen.getByRole("heading", { name: "Refused by policy, there is nothing to approve" })).toBeTruthy()
})

it("puts the rule it broke in its own block, with who set it and where it applies", () => {
  render(<PolicyRefusalCard refusal={refusal} />)
  const block = screen.getByRole("group", { name: "The rule it broke" })
  expect(within(block).getByText("THE RULE IT BROKE")).toBeTruthy()
  expect(within(block).getByText(refusal.rule)).toBeTruthy()
  const terms = [...block.querySelectorAll("dt")].map((term) => term.textContent)
  expect(terms).toEqual(["Set by", "Applies to"])
  expect(within(block).getByText(refusal.setBy)).toBeTruthy()
  expect(within(block).getByText(refusal.scope)).toBeTruthy()
})

it("lists the remedy under What you can do instead", () => {
  render(<PolicyRefusalCard refusal={refusal} />)
  const instead = screen.getByRole("region", { name: "What you can do instead" })
  expect(within(instead).getByRole("listitem").textContent).toBe(refusal.remedy)
})

it("does not dress a refusal as a waiting gate", () => {
  const { container } = render(<PolicyRefusalCard refusal={refusal} />)
  // Amber is reserved for a gate that is waiting on a person. Nobody is
  // waiting here, so no warn token may appear.
  expect(container.innerHTML).not.toMatch(/warn|warning/)
})
