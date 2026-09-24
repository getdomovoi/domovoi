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
  render(<ArchiveSessionAction disabled={false} onArchive={onArchive} worktreePath="/Users/dana/src/acme-api/.domovoi/wt-billing-idem" branch="wt-billing-idem" />)
  await user.click(screen.getByRole("button", { name: "Archive session" }))
  const dialog = screen.getByRole("alertdialog")
  expect(within(dialog).getByText("Archive this session?")).toBeTruthy()
  expect(dialog.textContent).toContain("Domovoi takes a final checkpoint, stops the agent and its terminals, then removes the worktree directory. Nothing is merged.")
  const removed = within(dialog).getByRole("list", { name: "REMOVED" })
  expect(removed.textContent).toContain("The worktree directory")
  expect(removed.textContent).toContain("/Users/dana/src/acme-api/.domovoi/wt-billing-idem")
  expect(removed.textContent).toContain("The agent and its terminals, stopped")
  const kept = within(dialog).getByRole("list", { name: "KEPT" })
  const branchItem = within(kept).getAllByRole("listitem")[0]!
  expect(branchItem.textContent).toBe("The branch wt-billing-idem, as it is")
  expect(within(branchItem).getByText("wt-billing-idem").className).toContain("font-machine")
  expect(kept.textContent).not.toContain("never merged")
  expect(kept.textContent).toContain("The final checkpoint, taken on that branch")
  expect(kept.textContent).toContain("The thread, readable here")
  expect(dialog.textContent).toContain("This cannot be undone. An archived session cannot be forked, unarchived or sent to.")
  await user.click(within(dialog).getByRole("button", { name: "Keep the session" }))
  expect(onArchive).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Archive session" }))
  await user.click(screen.getByRole("button", { name: "Archive and remove the worktree" }))
  expect(onArchive).toHaveBeenCalledOnce()
})

// Ruled 2026-09-23: the daemon counts unmerged files only while archiving, so
// the confirmation cannot know the count and must not imply files exist.
it("names the session branch as it is when the branch is not known", async () => {
  const user = userEvent.setup()
  render(<ArchiveSessionAction disabled={false} onArchive={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "Archive session" }))
  const kept = within(screen.getByRole("alertdialog")).getByRole("list", { name: "KEPT" })
  expect(within(kept).getAllByRole("listitem")[0]!.textContent).toBe("The session branch, as it is")
})
