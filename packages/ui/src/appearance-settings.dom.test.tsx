import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { ProviderSettings } from "./provider-settings.js"

afterEach(cleanup)

function settingsProps() {
  return {
    providers: [],
    secrets: [],
    onBack: vi.fn(),
    onOpenSkills: vi.fn(),
    onOpenAudit: vi.fn(),
  }
}

function openAppearance() {
  return userEvent.click(screen.getAllByRole("button", { name: "Appearance" })[0]!)
}

it("offers system, dark, and light theme cards beside provider settings", async () => {
  const onThemeChange = vi.fn()
  render(
    <ProviderSettings
      {...settingsProps()}
      theme="system"
      onThemeChange={onThemeChange}
    />,
  )

  expect(screen.getAllByRole("button", { name: "Providers" }).length).toBeGreaterThan(0)
  await openAppearance()

  const themes = within(screen.getByRole("radiogroup", { name: "Theme" }))
  expect(themes.getByRole("radio", { name: /System/u }).getAttribute("aria-checked")).toBe("true")
  expect(themes.getByRole("radio", { name: /Dark/u })).toBeTruthy()

  await userEvent.click(themes.getByRole("radio", { name: /Light/u }))
  expect(onThemeChange).toHaveBeenCalledWith("light")
})

it("hides window decoration on clients that cannot change it", async () => {
  render(
    <ProviderSettings
      {...settingsProps()}
      theme="dark"
      onThemeChange={vi.fn()}
    />,
  )
  await openAppearance()

  expect(screen.queryByRole("radiogroup", { name: "Window decoration" })).toBeNull()
})

it("states that a window decoration change applies after a restart", async () => {
  const onWindowDecorationChange = vi.fn()
  render(
    <ProviderSettings
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
  await openAppearance()

  const decoration = within(screen.getByRole("radiogroup", { name: "Window decoration" }))
  await userEvent.click(decoration.getByRole("radio", { name: /System/u }))
  expect(onWindowDecorationChange).toHaveBeenCalledWith("system")
  expect(screen.getByText(/Restart Domovoi/u)).toBeTruthy()
})

it("announces a stored decoration the running window has not adopted", async () => {
  render(
    <ProviderSettings
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
  await openAppearance()

  expect(screen.getByRole("status").textContent).toMatch(
    /This window still uses the Domovoi decoration/u,
  )
})

it("keeps the external editor control reachable alongside appearance", async () => {
  render(
    <ProviderSettings
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

  await userEvent.click(screen.getAllByRole("button", { name: "External editor" })[0]!)
  expect(screen.getByText("Worktree handoff")).toBeTruthy()
})
