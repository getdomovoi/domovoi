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
    onOpenSkills: vi.fn(),
    onOpenFleet: vi.fn(),
    onOpenAudit: vi.fn(),
    theme: "system" as const,
    onThemeChange: vi.fn(),
  }
}

it("renders the v2 settings contract as one ordered scrolling column", () => {
  const { container } = render(<SettingsShell {...shellProps()} />)

  expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy()
  expect(screen.getByText("This machine holds its own settings. Nothing here is synced anywhere unless the row says so.")).toBeTruthy()
  expect(screen.queryByRole("navigation", { name: "Settings" })).toBeNull()

  const content = container.textContent ?? ""
  const sections = ["Providers and tokens", "Notifications", "Permissions and rules", "Elsewhere", "Appearance"]
  const positions = sections.map((section) => content.indexOf(section))
  expect(positions.every((position) => position >= 0)).toBe(true)
  expect(positions).toEqual([...positions].sort((left, right) => left - right))
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

  expect(screen.getByRole("heading", { name: "External editor" })).toBeTruthy()
})

it("routes fleet and skills to the surfaces that own them", async () => {
  const props = shellProps()
  render(<SettingsShell {...props} />)

  await userEvent.click(screen.getByRole("button", { name: /Machines and daemons/u }))
  await userEvent.click(screen.getByRole("button", { name: /Skills/u }))

  expect(props.onOpenFleet).toHaveBeenCalledTimes(1)
  expect(props.onOpenSkills).toHaveBeenCalledTimes(1)
})

const activeRule: Extract<ApprovalRule, { status: "active" }> = {
  id: "rule-1",
  useCount: 0,
  projectId: "project-1",
  operation: "shell",
  command: "pnpm test",
  createdBy: "desktop",
  createdAt: "2026-09-03T10:00:00.000Z",
  status: "active",
  execution: {
    state: "resolved",
    digest: `sha256:${"a".repeat(64)}`,
    record: {
      version: 1,
      cwd: ".",
      kind: "shell",
      coverage: "command-and-script-text",
      entries: [{ id: 0, source: { kind: "request" }, parts: [{ operator: null, argv: ["pnpm", "test"], expandsTo: [] }] }],
    },
  },
}

const legacyRule: ApprovalRule = {
  id: "rule-2",
  useCount: 0,
  projectId: "project-1",
  operation: "shell",
  command: "pnpm build",
  createdBy: "web",
  createdAt: "2026-08-30T10:00:00.000Z",
  status: "inactive",
  inactiveReason: "legacy-text-only",
  inactivatedAt: "2026-09-03T09:00:00.000Z",
}

it("shows standing rules with the client that created them", async () => {
  render(<SettingsShell {...shellProps()} approvalRules={[activeRule]} />)

  const rules = within(screen.getByRole("list", { name: "Standing approval rules" }))
  const entry = within(rules.getAllByRole("listitem")[0]!)
  expect(entry.getByText("pnpm test")).toBeTruthy()
  expect(entry.getByText(/shell/u)).toBeTruthy()
  expect(entry.getByText(/desktop/u)).toBeTruthy()
})

it("says what a rule match does not cover", async () => {
  render(<SettingsShell {...shellProps()} approvalRules={[activeRule]} />)

  expect(screen.getByText(/Matches command and package-script text only/u)).toBeTruthy()
  expect(screen.getByText(/dependency binaries may still change/u)).toBeTruthy()
})

it("says a worktree-wide file-tool rule no longer matches", async () => {
  const fileRule: ApprovalRule = {
    ...activeRule,
    id: "rule-3",
    command: "Edit",
    execution: {
      state: "resolved",
      digest: `sha256:${"b".repeat(64)}`,
      record: {
        version: 1,
        cwd: ".",
        kind: "workspace-file-tool",
        coverage: "tool-and-workspace-scope",
        tool: "Edit",
        scope: "workspace",
      },
    },
  }
  render(<SettingsShell {...shellProps()} approvalRules={[fileRule]} />)

  expect(screen.getByText(/made for the whole worktree no longer matches anything/u)).toBeTruthy()
  expect(screen.queryByText(/Matches command and package-script text only/u)).toBeNull()
})

it("says a file-tool rule covers one file", async () => {
  const fileRule: ApprovalRule = {
    ...activeRule,
    id: "rule-4",
    command: "Edit",
    execution: {
      state: "resolved",
      digest: `sha256:${"c".repeat(64)}`,
      record: {
        version: 1,
        cwd: ".",
        kind: "workspace-file-tool",
        coverage: "tool-and-file",
        tool: "Edit",
        scope: "file",
        path: "src/index.ts",
      },
    },
  }
  render(<SettingsShell {...shellProps()} approvalRules={[fileRule]} />)

  expect(screen.getByText(/matches that tool on one file/u)).toBeTruthy()
})

it("announces a retired legacy rule before its approval card returns", async () => {
  render(<SettingsShell {...shellProps()} approvalRules={[activeRule, legacyRule]} />)

  const retired = within(screen.getByRole("list", { name: "Retired approval rules" }))
  const entry = within(retired.getAllByRole("listitem")[0]!)
  expect(entry.getByText("pnpm build")).toBeTruthy()
  expect(entry.getByText(/text only/u)).toBeTruthy()
  expect(entry.getByText(/needs explicit reapproval/u)).toBeTruthy()
  expect(within(screen.getByRole("list", { name: "Standing approval rules" })).queryByText("pnpm build")).toBeNull()
})

it("keeps a retired rule out of the active list even when it is the only rule", async () => {
  render(<SettingsShell {...shellProps()} approvalRules={[legacyRule]} />)

  expect(screen.getByText(/No standing rules/u)).toBeTruthy()
  expect(screen.getByRole("list", { name: "Retired approval rules" })).toBeTruthy()
})

it("states when a project has no standing rules", async () => {
  render(<SettingsShell {...shellProps()} />)

  expect(screen.getByText(/No standing rules/u)).toBeTruthy()
  expect(screen.queryByRole("list", { name: "Standing approval rules" })).toBeNull()
})

it("changes one notification kind without disturbing the others", async () => {
  const props = shellProps()
  render(<SettingsShell {...props} />)

  await userEvent.click(screen.getByRole("switch", { name: "Failures" }))

  expect(props.onNotificationsChange).toHaveBeenCalledWith({
    completion: true,
    failure: false,
    approvalNeeded: true,
  })
})

it("describes the local daemon on the machine pane when the client knows how it is served", () => {
  render(
    <SettingsShell
      {...shellProps()}
      localDaemon={{
        title: "Connected to the installed Domovoi service",
        detail: "The daemon runs outside this app and keeps running after it quits.",
      }}
    />,
  )

  const section = within(screen.getByRole("region", { name: /local daemon/iu }))
  expect(section.getByText("Connected to the installed Domovoi service")).toBeTruthy()
  expect(section.getByText("The daemon runs outside this app and keeps running after it quits.")).toBeTruthy()
})

it("draws no local daemon section for a client that cannot say how the daemon is served", () => {
  render(<SettingsShell {...shellProps()} />)

  expect(screen.queryByRole("region", { name: /local daemon/iu })).toBeNull()
  expect(screen.queryByText(/Domovoi service/u)).toBeNull()
})
