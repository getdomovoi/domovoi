import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { ArchiveSessionAction } from "./thread"

afterEach(cleanup)

// I69: the confirmation says exactly what archive does. Removed and kept are
// listed, the loss is named, and the actions say what they do.
it("lists what archive removes and keeps, and cannot be undone", async () => {
  const user = userEvent.setup()
  const onArchive = vi.fn()
  render(<ArchiveSessionAction disabled={false} onArchive={onArchive} worktreePath="/Users/dana/src/acme-api/.domovoi/wt-billing-idem" branch="wt-billing-idem" unmergedFiles={7} />)
  await user.click(screen.getByRole("button", { name: "Archive session" }))
  const dialog = screen.getByRole("alertdialog")
  expect(within(dialog).getByText("Archive this session?")).toBeTruthy()
  expect(dialog.textContent).toContain("Domovoi takes a final checkpoint, stops the agent and its terminals, then removes the worktree directory. Nothing is merged.")
  const removed = within(dialog).getByRole("list", { name: "REMOVED" })
  expect(removed.textContent).toContain("The worktree directory")
  expect(removed.textContent).toContain("/Users/dana/src/acme-api/.domovoi/wt-billing-idem")
  expect(removed.textContent).toContain("The agent and its terminals, stopped")
  const kept = within(dialog).getByRole("list", { name: "KEPT" })
  expect(kept.textContent).toContain("The branch wt-billing-idem, with the 7 files that were never merged")
  expect(kept.textContent).toContain("The final checkpoint, taken on that branch")
  expect(kept.textContent).toContain("The thread, readable here")
  expect(dialog.textContent).toContain("This cannot be undone. An archived session cannot be forked, unarchived or sent to.")
  await user.click(within(dialog).getByRole("button", { name: "Keep the session" }))
  expect(onArchive).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Archive session" }))
  await user.click(screen.getByRole("button", { name: "Archive and remove the worktree" }))
  expect(onArchive).toHaveBeenCalledOnce()
})
