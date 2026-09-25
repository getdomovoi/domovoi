import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { demoWorkspace, type Artifact, type ArtifactAccess, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { AnnotationDraftCopy, ArtifactDock } from "./artifact-dock"

const sessionId = demoWorkspace.activeSessionId!
const previews: Artifact[] = [
  {
    id: "artifact-preview-a",
    sessionId,
    title: "Webhook replay A",
    type: "preview",
    revision: 1,
    mimeType: "text/html",
    path: ".domovoi/previews/a.html",
    variant: { groupId: "webhook-replay", id: "a", label: "Variant A", order: 1 },
  },
  {
    id: "artifact-preview-b",
    sessionId,
    title: "Webhook replay B",
    type: "preview",
    revision: 1,
    mimeType: "text/html",
    path: ".domovoi/previews/b.html",
    variant: { groupId: "webhook-replay", id: "b", label: "Variant B", order: 2 },
  },
]
const snapshot: WorkspaceSnapshot = { ...demoWorkspace, artifacts: previews, annotations: [] }

function renderDock(
  authorizeArtifact: (input: { sessionId: string; artifactId: string; revision: number; purpose: ArtifactAccess["purpose"] }) => Promise<ArtifactAccess> = () => new Promise(() => {}),
) {
  render(
    <ArtifactDock
      snapshot={snapshot}
      onCollapse={vi.fn()}
      defaultTab="preview"
      rpcUrl="ws://127.0.0.1:47831/rpc"
      authorizeArtifact={authorizeArtifact}
      connected
      terminalControls={{ claim: vi.fn(), release: vi.fn(), write: vi.fn(), resize: vi.fn() } as never}
      onReplyToAnnotation={vi.fn()}
      onSetAnnotationStatus={vi.fn()}
      onCreateAnnotation={vi.fn()}
      onLoadSessionHistory={vi.fn()}
      onLoadSessionEvidence={vi.fn()}
      onRevertSessionFile={vi.fn()}
    />,
  )
}

afterEach(cleanup)

it("uses the signed review draft actions", () => {
  expect(AnnotationDraftCopy).toEqual({
    placeholder: "Say what is wrong with this element",
    submit: "Post",
    cancel: "Cancel",
  })
})

it("keeps the viewed preview distinct from the build basis", async () => {
  const user = userEvent.setup()
  renderDock()

  expect(screen.getByText("Build basis · Variant B")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: /Variant A/ }))
  expect(screen.getByText("Viewing · Variant A")).toBeTruthy()
  expect(screen.getByText("Build basis · Variant B")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Use Variant A as build basis" }))
  expect(screen.getByText("Build basis · Variant A")).toBeTruthy()
})

it("keeps sandbox authorization and sheet controls visible", () => {
  renderDock()

  expect(document.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts")
  expect(screen.getByText("sandboxed", { exact: false })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy()
})

it("sandboxes every preview frame, comparison stages and fullscreen included", async () => {
  const user = userEvent.setup()
  // The frames only need their attributes read, not their pages fetched.
  const settings = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM?.settings
  const loadedFrames = settings?.disableIframePageLoading
  if (settings) settings.disableIframePageLoading = true
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, width: 1_200, height: 800, right: 1_200, bottom: 800, toJSON: () => ({}),
  } as DOMRect)
  try {
    renderDock(async (input) => ({
      sessionId: input.sessionId,
      artifactId: input.artifactId,
      revision: input.revision,
      purpose: input.purpose,
      expiresAt: Date.now() + 60_000,
      signature: `signature-${input.artifactId}`,
    }) as ArtifactAccess)
    await user.click(screen.getByRole("button", { name: "Compare" }))
    await waitFor(() => expect(document.querySelectorAll("iframe")).toHaveLength(2))
    await waitFor(() => {
      for (const frame of document.querySelectorAll("iframe")) expect(frame.getAttribute("src")).toMatch(/^http:\/\/127\.0\.0\.1:47831\/artifacts\//)
    })
    await user.click(screen.getByRole("button", { name: "Open fullscreen preview" }))
    const fullscreen = await screen.findByTitle(/fullscreen$/)

    const frames = [...document.querySelectorAll("iframe")]
    expect(frames).toContain(fullscreen)
    expect(frames.length).toBeGreaterThanOrEqual(3)
    for (const frame of frames) expect(frame.getAttribute("sandbox"), frame.title).toBe("allow-scripts")
  } finally {
    bounds.mockRestore()
    if (settings && loadedFrames !== undefined) settings.disableIframePageLoading = loadedFrames
  }
})

it("opens an authorized preview fullscreen and exits it", async () => {
  const user = userEvent.setup()
  renderDock()

  await user.click(screen.getByRole("button", { name: "Open fullscreen preview" }))
  expect(screen.getByRole("dialog")).toBeTruthy()
  expect(screen.getByText("Exit fullscreen")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Exit fullscreen" }))
  expect(screen.queryByRole("dialog")).toBeNull()
})
