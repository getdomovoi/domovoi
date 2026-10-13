import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { defaultNotificationPreferences } from "./notification-preferences.js"
import { NotificationSettings } from "./notification-settings.js"
import type { WorkspaceClientCapabilities } from "./workspace-platform.js"

afterEach(cleanup)

function capabilities(overrides: Partial<WorkspaceClientCapabilities> = {}): WorkspaceClientCapabilities {
  return {
    delivery: { status: "ready" },
    install: { status: "installed" },
    onRequestDelivery: vi.fn(),
    onInstall: vi.fn(),
    ...overrides,
  }
}

// The kinds a person can switch off. The gate row is never one of them (Q363 A).
function switches() {
  return ["Completions", "Failures"].map((label) =>
    screen.getByRole("switch", { name: label }),
  )
}

it("leaves a host that raises notifications itself untouched", () => {
  render(<NotificationSettings preferences={defaultNotificationPreferences()} onChange={vi.fn()} />)

  expect(screen.queryByText("This client")).toBeNull()
  for (const control of switches()) expect(control.getAttribute("disabled")).toBeNull()
})

it("offers the permission request a browser has not been asked for", async () => {
  const client = capabilities({ delivery: { status: "askable" } })
  render(<NotificationSettings preferences={defaultNotificationPreferences()} onChange={vi.fn()} client={client} />)

  await userEvent.click(screen.getByRole("button", { name: "Allow notifications" }))

  expect(client.onRequestDelivery).toHaveBeenCalledOnce()
  for (const control of switches()) expect(control.getAttribute("disabled")).toBeNull()
})

it("refuses the kinds outright when the browser will not raise them", () => {
  const client = capabilities({
    delivery: { status: "refused", message: "This browser has blocked notifications for Domovoi." },
  })
  render(<NotificationSettings preferences={defaultNotificationPreferences()} onChange={vi.fn()} client={client} />)

  expect(screen.getByText("This browser has blocked notifications for Domovoi.")).toBeTruthy()
  expect(screen.getByRole("alert").textContent).toContain("This browser will not raise notifications")
  expect(screen.queryByRole("button", { name: "Allow notifications" })).toBeNull()
  for (const control of switches()) expect(control.getAttribute("disabled")).toBe("")
})

it("never changes a preference a refused browser cannot honour", async () => {
  const onChange = vi.fn()
  const client = capabilities({ delivery: { status: "refused", message: "Blocked in site settings." } })
  render(<NotificationSettings preferences={defaultNotificationPreferences()} onChange={onChange} client={client} />)

  await userEvent.click(screen.getByRole("switch", { name: "Completions" }))

  expect(onChange).not.toHaveBeenCalled()
})

it("offers the install prompt only where the browser has one", async () => {
  const client = capabilities({ install: { status: "installable" } })
  const { rerender } = render(
    <NotificationSettings preferences={defaultNotificationPreferences()} onChange={vi.fn()} client={client} />,
  )

  await userEvent.click(screen.getByRole("button", { name: "Install Domovoi" }))
  expect(client.onInstall).toHaveBeenCalledOnce()

  rerender(
    <NotificationSettings
      preferences={defaultNotificationPreferences()}
      onChange={vi.fn()}
      client={capabilities({ install: { status: "manual", message: "Use the browser's own install menu item." } })}
    />,
  )

  expect(screen.queryByRole("button", { name: "Install Domovoi" })).toBeNull()
  expect(screen.getByText("Use the browser's own install menu item.")).toBeTruthy()
})

it("keeps the gate notification on, whatever the person presses (Q363 A)", async () => {
  const onChange = vi.fn()
  render(<NotificationSettings preferences={defaultNotificationPreferences()} onChange={onChange} />)

  const gate = screen.getByRole("switch", { name: "A gate is waiting on you" })
  expect(gate.getAttribute("aria-checked")).toBe("true")
  expect(gate.getAttribute("disabled")).toBe("")
  expect(screen.getByText("Always on. This is the one thing that blocks work.")).toBeTruthy()
  expect(screen.getAllByRole("switch")[0]).toBe(gate)

  await userEvent.click(gate)
  expect(onChange).not.toHaveBeenCalled()
})

it("says on the desktop that the choices stay on this desktop", () => {
  render(<NotificationSettings preferences={defaultNotificationPreferences()} onChange={vi.fn()} />)

  expect(screen.getByText(/This desktop only\. A waiting gate always notifies, and the rest is yours\./u)).toBeTruthy()
})

it("locks the gate notification on in a browser too (Q56 A)", () => {
  render(<NotificationSettings preferences={defaultNotificationPreferences()} onChange={vi.fn()} client={capabilities()} />)

  const gate = screen.getByRole("switch", { name: "A gate is waiting on you" })
  expect(gate.getAttribute("aria-checked")).toBe("true")
  expect(gate.getAttribute("disabled")).toBe("")
  expect(screen.queryByText(/This desktop only/u)).toBeNull()
  expect(screen.getByText(/This browser only\. A waiting gate always notifies, and the rest is yours\./u)).toBeTruthy()
})

it("switches a kind the person may turn off, and keeps the gate on in the record", async () => {
  const onChange = vi.fn()
  render(<NotificationSettings preferences={defaultNotificationPreferences()} onChange={onChange} />)

  await userEvent.click(screen.getByRole("switch", { name: "Failures" }))

  expect(onChange).toHaveBeenCalledWith({ completion: true, failure: false, approvalNeeded: true })
})
