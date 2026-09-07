import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { fireEvent, render, screen } from "@testing-library/react-native"

import { reviewRows } from "../review-rows"
import { ReviewScreen } from "./review"

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

async function draw(overrides: Partial<Parameters<typeof ReviewScreen>[0]> = {}) {
  const props = {
    rows: reviewRows(workspace()),
    notice: undefined,
    hasSnapshot: true,
    onOpenArtifact: jest.fn<(artifactId: string) => void>(),
    ...overrides,
  }
  await render(<ReviewScreen {...props} />)
  return props
}

describe("ReviewScreen", () => {
  it("lists every artifact with the session that produced it", async () => {
    const snapshot = workspace()
    await draw()
    for (const artifact of snapshot.artifacts) {
      expect(screen.getByText(artifact.title)).toBeOnTheScreen()
    }
    const session = snapshot.sessions.find((entry) => entry.id === snapshot.artifacts[0]?.sessionId)
    expect(screen.getAllByText(session?.title ?? "").length).toBeGreaterThan(0)
  })

  it("counts what is still open, in the summary and on the row", async () => {
    const snapshot = workspace()
    const open = snapshot.annotations.filter((entry) => entry.status === "open").length
    await draw()
    expect(screen.getByText(`${snapshot.artifacts.length} artifacts · ${open} open`))
      .toBeOnTheScreen()
    expect(screen.getAllByText(/^\d+ open$/).length).toBeGreaterThan(1)
  })

  it("opens the artifact that was tapped", async () => {
    const snapshot = workspace()
    const { onOpenArtifact } = await draw()
    const artifact = snapshot.artifacts[0]
    if (!artifact) throw new Error("the demo workspace carries no artifact")
    await fireEvent.press(screen.getByRole("button", { name: `Open ${artifact.title}` }))
    expect(onOpenArtifact).toHaveBeenCalledWith(artifact.id)
  })

  // Nothing to review and nothing heard yet look the same on screen, and they
  // mean opposite things, so the screen is not allowed to claim the first when
  // it only knows the second.
  it("does not call an unanswered daemon an empty workspace", async () => {
    await draw({ rows: [], hasSnapshot: false })
    expect(screen.queryByText(/Nothing has been rendered for review/)).toBeNull()
    expect(screen.getByText("Nothing has been received from this daemon yet.")).toBeOnTheScreen()
  })

  it("says the workspace is empty once the daemon has answered", async () => {
    await draw({ rows: [], hasSnapshot: true })
    expect(screen.getByText(/Nothing has been rendered for review/)).toBeOnTheScreen()
    expect(screen.getByText("0 artifacts · 0 open")).toBeOnTheScreen()
  })
})
