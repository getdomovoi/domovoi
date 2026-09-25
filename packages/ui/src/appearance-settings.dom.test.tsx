import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { defaultNotificationPreferences } from "./notification-preferences.js"
import { SettingsShell } from "./settings-shell.js"

afterEach(cleanup)

function settingsProps() {
  return {
    providers: [],
    secrets: [],
    approvalRules: [],
    notifications: defaultNotificationPreferences(),
    onNotificationsChange: vi.fn(),
    onOpenFleet: vi.fn(),
    onOpenSkills: vi.fn(),
    onOpenAudit: vi.fn(),
  }
}

it("offers system, dark, and light theme cards beside provider settings", async () => {
  const onThemeChange = vi.fn()
  render(
    <SettingsShell
      {...settingsProps()}
      theme="system"
      onThemeChange={onThemeChange}
    />,
  )

  expect(screen.getByRole("heading", { name: "Providers and tokens" })).toBeTruthy()

  const themes = within(screen.getByRole("radiogroup", { name: "Theme" }))
  expect(themes.getByRole("radio", { name: /System/u }).getAttribute("aria-checked")).toBe("true")
  expect(themes.getByRole("radio", { name: /Dark/u })).toBeTruthy()
  expect(themes.getByText("Follows your OS appearance, including scheduled switches.")).toBeTruthy()
  expect(themes.getByText("The default. Tuned for long sessions and terminal output.")).toBeTruthy()
  expect(themes.getByText("The same tokens inverted. Diffs read on paper-white.")).toBeTruthy()

  await userEvent.click(themes.getByRole("radio", { name: /Light/u }))
  expect(onThemeChange).toHaveBeenCalledWith("light")
})

it("hides window decoration on clients that cannot change it", async () => {
  render(
    <SettingsShell
      {...settingsProps()}
      theme="dark"
      onThemeChange={vi.fn()}
    />,
  )
  expect(screen.queryByRole("radiogroup", { name: "Window decoration" })).toBeNull()
})

it("states that a window decoration change applies after a restart", async () => {
  const onWindowDecorationChange = vi.fn()
  render(
    <SettingsShell
      {...settingsProps()}
      theme="dark"
      onThemeChange={vi.fn()}
      externalEditor="system"
      onExternalEditorChange={vi.fn()}
      windowDecoration="domovoi"
      activeWindowDecoration="domovoi"
      onWindowDecorationChange={onWindowDecorationChange}
    />,
  )
  const decoration = within(screen.getByRole("radiogroup", { name: "Window decoration" }))
  await userEvent.click(decoration.getByRole("radio", { name: /System/u }))
  expect(onWindowDecorationChange).toHaveBeenCalledWith("system")
  expect(screen.getByText(/Restart Domovoi/u)).toBeTruthy()
})

it("announces a stored decoration the running window has not adopted", async () => {
  render(
    <SettingsShell
      {...settingsProps()}
      theme="dark"
      onThemeChange={vi.fn()}
      externalEditor="system"
      onExternalEditorChange={vi.fn()}
      windowDecoration="system"
      activeWindowDecoration="domovoi"
      onWindowDecorationChange={vi.fn()}
    />,
  )
  expect(screen.getByRole("status").textContent).toMatch(
    /This window still uses the Domovoi decoration/u,
  )
})

it("keeps the external editor control reachable alongside appearance", async () => {
  render(
    <SettingsShell
      {...settingsProps()}
      theme="system"
      onThemeChange={vi.fn()}
      externalEditor="zed"
      onExternalEditorChange={vi.fn()}
      windowDecoration="domovoi"
      activeWindowDecoration="domovoi"
      onWindowDecorationChange={vi.fn()}
    />,
  )

  expect(screen.getByRole("heading", { name: "External editor" })).toBeTruthy()
  expect(screen.getByText("Worktree handoff")).toBeTruthy()
})
