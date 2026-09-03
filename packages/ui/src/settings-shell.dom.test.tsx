import type { ApprovalRule } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { defaultNotificationPreferences } from "./notification-preferences.js"
import { SettingsShell } from "./settings-shell.js"

afterEach(cleanup)

function shellProps() {
  return {
    providers: [],
    secrets: [],
    approvalRules: [] as readonly ApprovalRule[],
    notifications: defaultNotificationPreferences(),
    onNotificationsChange: vi.fn(),
    onBack: vi.fn(),
    onOpenSkills: vi.fn(),
    onOpenFleet: vi.fn(),
    onOpenAudit: vi.fn(),
    theme: "system" as const,
    onThemeChange: vi.fn(),
  }
}

function nav() {
  return within(screen.getByRole("navigation", { name: "Settings" }))
}

function openPane(name: string) {
  return userEvent.click(nav().getByRole("button", { name }))
}

it("lists every settings destination in the handoff order", () => {
  render(<SettingsShell {...shellProps()} />)

  const labels = nav().getAllByRole("button").map((button) => button.textContent)
  expect(labels).toEqual([
    "Workspace",
    "Fleet & machines",
    "Skills",
    "Providers",
    "Appearance & window",
    "Permissions & rules",
    "Notifications",
    "Audit log",
  ])
})

it("adds External editor only where the client can change it", () => {
  render(
    <SettingsShell
      {...shellProps()}
      externalEditor="system"
      onExternalEditorChange={vi.fn()}
      windowDecoration="domovoi"
      activeWindowDecoration="domovoi"
      onWindowDecorationChange={vi.fn()}
    />,
  )

  expect(nav().getByRole("button", { name: "External editor" })).toBeTruthy()
})

it("routes fleet and skills to the surfaces that own them", async () => {
  const props = shellProps()
  render(<SettingsShell {...props} />)

  await openPane("Fleet & machines")
  await openPane("Skills")

  expect(props.onOpenFleet).toHaveBeenCalledTimes(1)
  expect(props.onOpenSkills).toHaveBeenCalledTimes(1)
})

it("shows standing rules with the client that created them", async () => {
  const rule: ApprovalRule = {
    id: "rule-1",
    projectId: "project-1",
    operation: "shell",
    command: "pnpm test",
    createdBy: "desktop",
    createdAt: "2026-09-03T10:00:00.000Z",
  }
  render(<SettingsShell {...shellProps()} approvalRules={[rule]} />)

  await openPane("Permissions & rules")

  const rules = within(screen.getByRole("list", { name: "Standing approval rules" }))
  const entry = within(rules.getAllByRole("listitem")[0]!)
  expect(entry.getByText("pnpm test")).toBeTruthy()
  expect(entry.getByText(/shell/u)).toBeTruthy()
  expect(entry.getByText(/desktop/u)).toBeTruthy()
})

it("states when a project has no standing rules", async () => {
  render(<SettingsShell {...shellProps()} />)

  await openPane("Permissions & rules")

  expect(screen.getByText(/No standing rules/u)).toBeTruthy()
  expect(screen.queryByRole("list", { name: "Standing approval rules" })).toBeNull()
})

it("changes one notification kind without disturbing the others", async () => {
  const props = shellProps()
  render(<SettingsShell {...props} />)

  await openPane("Notifications")
  await userEvent.click(screen.getByRole("switch", { name: "Failures" }))

  expect(props.onNotificationsChange).toHaveBeenCalledWith({
    completion: true,
    failure: false,
    approvalNeeded: true,
  })
})
