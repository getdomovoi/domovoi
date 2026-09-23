import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { SettingsShell } from "./settings-shell"

afterEach(cleanup)

it("hosts the pairing card under Phone and tablet and sends device management to Machines", async () => {
  const user = userEvent.setup()
  const onOpenFleet = vi.fn()
  render(<SettingsShell
    providers={[]} secrets={[]} approvalRules={[]}
    notifications={{ completion: true, failure: true, approvalNeeded: true }} onNotificationsChange={vi.fn()}
    onOpenFleet={onOpenFleet} onOpenSkills={vi.fn()} onOpenAudit={vi.fn()} theme="system" onThemeChange={vi.fn()}
    pairing={{ onIssueCode: vi.fn(async () => ({ code: "hearth-quiet-ember-42", expiresAt: new Date().toISOString(), pairingAddress: { url: "wss://mac-mini-m4.tail4c2e.ts.net:47831/rpc", loopback: false } })), onCopy: vi.fn(async () => {}), onListDevices: vi.fn(async () => ({ devices: [{ id: `device-${"d".repeat(32)}`, label: "iPhone", pairedAt: "2026-09-01T00:00:00.000Z", binding: { kind: "client" as const, client: "phone" as const, clientAccess: "full" as const } }] })) }}
  />)
  const section = screen.getByRole("region", { name: "Phone and tablet" })
  expect(section.textContent).toContain("Pair a device to watch sessions and answer gates while away from the desk.")
  expect(section.textContent).toContain("Show a pairing code")
  expect(await screen.findByText("1 client paired with this daemon")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: /Rename, rotate and unpair them on Machines/ }))
  expect(onOpenFleet).toHaveBeenCalledOnce()
})
