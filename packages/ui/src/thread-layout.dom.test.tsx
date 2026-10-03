import { demoWorkspace } from "@getdomovoi/protocol"
import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

// The design draws the conversation and the composer on one 760px column.
// Both read the same token, so the thread cannot drift narrower than the
// card under it again.
it("draws the thread column on the composer's width", () => {
  render(
    <Thread
      onQueuedChange={vi.fn()}
      snapshot={structuredClone(demoWorkspace)}
      connected
      onResolve={vi.fn(async () => {})}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [])}
      onNewSession={vi.fn()}
      onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
    />,
  )

  const column = document.querySelector("[data-thread-column]")
  const composer = document.querySelector("[data-workspace-composer]")
  if (!column || !composer) throw new Error("The thread column or the composer is missing")
  // The column keeps 24px of side padding inside its maximum, so its content
  // box is the token's width, the width of the composer's border box.
  expect(column.className.split(" ")).toEqual(expect.arrayContaining(["max-w-[calc(var(--shell-thread)+3rem)]", "px-6"]))
  expect(composer.className.split(" ")).toContain("max-w-[var(--shell-thread)]")
})
