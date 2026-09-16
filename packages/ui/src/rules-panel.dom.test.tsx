import type { ApprovalRule, HardGateCategory } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { RulesPanel, ruleScopeLabel, ruleUsedLabel } from "./rules-panel"

afterEach(cleanup)

const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

const execution: Extract<ApprovalRule, { status: "active" }>["execution"] = {
  state: "resolved",
  digest: "d".repeat(64),
  record: { version: 2, kind: "shell", coverage: "command-and-script-text", command: "pnpm vitest run *", cwd: ".", scripts: [] },
} as unknown as Extract<ApprovalRule, { status: "active" }>["execution"]

function rule(over: Record<string, unknown> & { id: string }): ApprovalRule {
  return {
    projectId: "project-acme",
    operation: "Run tests",
    command: "pnpm vitest run *",
    createdBy: "desktop",
    createdAt: "2026-09-03T10:00:00.000Z",
    useCount: 82,
    status: "active",
    execution,
    ...over,
  } as ApprovalRule
}

const gates: HardGateCategory[] = [
  { id: "destructive-operations", label: "delete files, drop, truncate or force-push" },
  { id: "outside-project", label: "access outside the project directory" },
]

function panel(extra: Partial<Parameters<typeof RulesPanel>[0]> = {}) {
  return (
    <RulesPanel
      rules={[rule({ id: "rule-tests" }), rule({ id: "rule-migrate", command: "pnpm -w prisma migrate *", operation: "Migrate", useCount: 1, createdAt: "2026-09-15T09:00:00.000Z" })]}
      projectName="acme-api"
      machineName="mac-mini-m4"
      onRevoke={vi.fn(async () => {})}
      onLoadHardGates={vi.fn(async () => gates)}
      {...extra}
    />
  )
}

// The design lists what you have already allowed, scoped to a repository and
// a machine, with how often each rule answered for you, a one-click Revoke,
// and the things a rule can never cover. The never-covered list comes from
// the daemon's own policy, not a copy of it.
it("lists the standing rules with scope and use count, and the daemon's never-covered categories", async () => {
  render(panel())
  await settle()
  const rows = screen.getAllByTestId("rule-row")
  expect(rows).toHaveLength(2)
  expect(within(rows[0]!).getByText("pnpm vitest run *")).toBeTruthy()
  expect(within(rows[0]!).getByText(/acme-api on mac-mini-m4 · created 3 Sep 2026 at a gate from desktop/)).toBeTruthy()
  expect(within(rows[0]!).getByText("used 82×")).toBeTruthy()
  expect(within(rows[1]!).getByText("used 1×")).toBeTruthy()
  const never = screen.getByRole("list", { name: "Never covered by a rule" })
  expect(within(never).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "delete files, drop, truncate or force-push", "access outside the project directory",
  ])
})

it("revokes a rule in one click, says the outcome is unconfirmed on an error, and lets you repeat the request", async () => {
  const user = userEvent.setup()
  const onRevoke = vi.fn<(ruleId: string) => Promise<void>>().mockRejectedValueOnce(new Error("Daemon connection is not open")).mockResolvedValueOnce(undefined)
  render(panel({ onRevoke }))
  await settle()
  const [first] = screen.getAllByTestId("rule-row")
  await user.click(within(first!).getByRole("button", { name: "Revoke" }))
  expect(onRevoke).toHaveBeenCalledWith("rule-tests")
  const alert = await within(first!).findByRole("alert")
  expect(alert.textContent).toMatch(/Daemon connection is not open/)
  expect(alert.textContent).toMatch(/not confirmed/)
  expect(alert.textContent).not.toMatch(/still stands/)
  await user.click(within(first!).getByRole("button", { name: "Revoke" }))
  expect(onRevoke).toHaveBeenCalledTimes(2)
})

// Two rows can be revoking at once. Each holds its own button shut until its
// own request settles, whichever order the daemon answers in.
it("keeps each revoking row shut until its own request settles", async () => {
  const user = userEvent.setup()
  const settlers: Record<string, () => void> = {}
  const onRevoke = vi.fn((ruleId: string) => new Promise<void>((resolve) => { settlers[ruleId] = resolve }))
  render(panel({ onRevoke }))
  await settle()
  const [first, second] = screen.getAllByTestId("rule-row")
  await user.click(within(first!).getByRole("button", { name: "Revoke" }))
  await user.click(within(second!).getByRole("button", { name: "Revoke" }))
  const button = (row: HTMLElement) => within(row).getByRole("button", { name: /Revok/ }) as HTMLButtonElement
  expect(button(first!).disabled).toBe(true)
  expect(button(second!).disabled).toBe(true)
  await act(async () => { settlers["rule-migrate"]!() })
  expect(button(first!).disabled).toBe(true)
  expect(button(second!).disabled).toBe(false)
  await act(async () => { settlers["rule-tests"]!() })
  expect(button(first!).disabled).toBe(false)
})

it("holds Revoke shut for a read-only viewer and says why", async () => {
  render(panel({ readOnly: true }))
  await settle()
  const revoke = within(screen.getAllByTestId("rule-row")[0]!).getByRole("button", { name: "Revoke" }) as HTMLButtonElement
  expect(revoke.disabled).toBe(true)
  expect(revoke.title).toMatch(/read-only/i)
})

it("says when there are no rules, and counts retired ones without listing them here", async () => {
  render(panel({ rules: [rule({ id: "old", status: "inactive", inactiveReason: "revoked", inactivatedAt: "2026-09-10T00:00:00.000Z", inactivatedBy: "cli", inactivatedByConnectionId: "conn-1" })] }))
  await settle()
  expect(screen.getByText(/No standing rules for this project/)).toBeTruthy()
  expect(screen.getByText(/1 retired rule is kept in Settings/)).toBeTruthy()
})

it("says when the never-covered list could not be read rather than showing an empty one", async () => {
  render(panel({ onLoadHardGates: vi.fn(async () => { throw new Error("hard gates offline") }) }))
  await settle()
  expect(screen.getByText(/could not be read/)).toBeTruthy()
  expect(screen.getByText(/hard gates offline/)).toBeTruthy()
})

it("formats scope and use count the way the design reads them", () => {
  expect(ruleScopeLabel(rule({ id: "r" }), "acme-api", "mac-mini-m4")).toBe("acme-api on mac-mini-m4 · created 3 Sep 2026 at a gate from desktop")
  expect(ruleUsedLabel(0)).toBe("never used")
  expect(ruleUsedLabel(1)).toBe("used 1×")
  expect(ruleUsedLabel(210)).toBe("used 210×")
})
