import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { StateRecoveryNotice } from "./state-recovery-notice"

afterEach(cleanup)

const recovery = {
  kind: "snapshot",
  quarantinedPath: "/Users/person/.domovoi/state.sqlite.snapshot-corrupt-2026-09-22T12-00-00-000Z.json",
  reason: "ZodError: sessions is invalid",
  occurredAt: "2026-09-22T12:00:00.000Z",
  pairedDevicesKept: true,
  workspaceKept: false,
} as const

it("names the kept file and whether paired devices survived", async () => {
  const onDismiss = vi.fn()
  render(<StateRecoveryNotice recovery={recovery} onDismiss={onDismiss} />)
  const notice = screen.getByRole("alert")
  expect(notice.textContent).toContain("Stored workspace could not be read")
  expect(notice.textContent).toContain(recovery.quarantinedPath)
  expect(notice.textContent).toContain("Paired devices were kept.")
  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
  expect(onDismiss).toHaveBeenCalledOnce()
})

it("says when paired devices must be paired again", () => {
  render(<StateRecoveryNotice recovery={{ ...recovery, kind: "database", pairedDevicesKept: false }} onDismiss={() => {}} />)
  const notice = screen.getByRole("alert")
  expect(notice.textContent).toContain("Stored state database could not be read")
  expect(notice.textContent).toContain("Pair them again.")
})

it("says when the workspace was kept and names no path a paired device was not given", () => {
  const { quarantinedPath: _path, reason: _reason, ...flag } = recovery
  render(<StateRecoveryNotice recovery={{ ...flag, kind: "database", workspaceKept: true }} onDismiss={() => {}} />)
  const notice = screen.getByRole("alert")
  expect(notice.textContent).toContain("Its workspace was still readable and was kept.")
  expect(notice.textContent).toContain("The unreadable copy was kept on that machine.")
  expect(notice.textContent).not.toContain("started from an empty workspace")
})
