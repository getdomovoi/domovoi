// D22 (SL-3b): the dock's inline comment draft, the comment rows and the
// variant chips with Build on this and Unpick, drawn from the desktop v2
// handoff (dock.preview-draft, dock.preview-comments, dock.preview-variants).
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { demoWorkspace, type Annotation, type Artifact, type ArtifactAccess, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { ArtifactDock } from "./artifact-dock"

const sessionId = demoWorkspace.activeSessionId!

function variant(id: string, order: number, revision = 1): Artifact {
  return {
    id: `replay-${id}`,
    sessionId,
    title: `Replay table ${id.toUpperCase()}`,
    type: "preview",
    revision,
    mimeType: "text/html",
    path: `design-studio/replay/${id}.html`,
    variant: { groupId: "replay", id, label: `Variant ${id.toUpperCase()}`, order },
  }
}

// Variant C is the newest, so the dock opens on it.
const variants = [variant("a", 1), variant("b", 2), variant("c", 3, 3)]
const snapshot: WorkspaceSnapshot = { ...demoWorkspace, artifacts: variants, annotations: [] }

type AuthorizeInput = Parameters<Parameters<typeof ArtifactDock>[0]["authorizeArtifact"]>[0]

function grantingAuthorize() {
  return vi.fn(async (input: AuthorizeInput): Promise<ArtifactAccess> => ({
    sessionId: input.sessionId,
    artifactId: input.artifactId,
    revision: input.revision,
    purpose: input.purpose,
    ...(input.bridgeChannel ? { bridgeChannel: input.bridgeChannel } : {}),
    ...(input.parentOrigin ? { parentOrigin: input.parentOrigin } : {}),
    expiresAt: Date.now() / 1_000 + 60,
    signature: "grant",
  }))
}

function Dock({
  dockSnapshot,
  authorize,
  initialBasis,
  onBuildBasisChange,
  onCreateAnnotation,
  onSetAnnotationStatus,
}: {
  dockSnapshot: WorkspaceSnapshot
  authorize: ReturnType<typeof grantingAuthorize>
  initialBasis?: string | undefined
  onBuildBasisChange: (artifactId: string | undefined) => void
  onCreateAnnotation: () => Promise<void>
  onSetAnnotationStatus: () => Promise<void>
}) {
  // The shell keeps the choice; this stands in for it.
  const [basis, setBasis] = useState(initialBasis)
  return (
    <ArtifactDock
      snapshot={dockSnapshot}
      buildBasisId={basis}
      onBuildBasisChange={(artifactId) => { setBasis(artifactId); onBuildBasisChange(artifactId) }}
      onCollapse={vi.fn()}
      defaultTab="preview"
      rpcUrl="ws://127.0.0.1:47831/rpc"
      authorizeArtifact={authorize}
      connected
      terminalControls={{ claim: vi.fn(), release: vi.fn(), write: vi.fn(), resize: vi.fn() } as never}
      onReplyToAnnotation={vi.fn()}
      onSetAnnotationStatus={onSetAnnotationStatus}
      onCreateAnnotation={onCreateAnnotation}
      onLoadSessionHistory={vi.fn()}
      onLoadSessionEvidence={() => new Promise<never>(() => {})}
      onRevertSessionFile={vi.fn()}
    />
  )
}

function renderDock(dockSnapshot: WorkspaceSnapshot = snapshot, initialBasis?: string) {
  const authorize = grantingAuthorize()
  const onBuildBasisChange = vi.fn()
  const onCreateAnnotation = vi.fn(async () => {})
  const onSetAnnotationStatus = vi.fn(async () => {})
  render(
    <Dock
      dockSnapshot={dockSnapshot}
      authorize={authorize}
      initialBasis={initialBasis}
      onBuildBasisChange={onBuildBasisChange}
      onCreateAnnotation={onCreateAnnotation}
      onSetAnnotationStatus={onSetAnnotationStatus}
    />,
  )
  return { authorize, onBuildBasisChange, onCreateAnnotation, onSetAnnotationStatus }
}

function frameTitled(title: string): HTMLIFrameElement {
  const frame = screen.getByTitle(title)
  if (!(frame instanceof HTMLIFrameElement)) throw new Error(`${title} is not a frame`)
  return frame
}

// Page loading is off, so a frame has no window of its own; this one stands in
// for the sandboxed page on the other end of the bridge.
function standInWindow(frame: HTMLIFrameElement) {
  const postMessage = vi.fn()
  const frameWindow = { postMessage } as unknown as Window
  Object.defineProperty(frame, "contentWindow", { configurable: true, get: () => frameWindow })
  return { frameWindow, postMessage }
}

// The frames only need their attributes and a stand-in window, not a page.
const happyDom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM
let loadedFrames: boolean | undefined
beforeEach(() => {
  loadedFrames = happyDom?.settings.disableIframePageLoading
  if (happyDom) happyDom.settings.disableIframePageLoading = true
})
afterEach(() => {
  cleanup()
  if (happyDom && loadedFrames !== undefined) happyDom.settings.disableIframePageLoading = loadedFrames
})

it("starts with none chosen, builds on the variant on screen, and Unpick clears it", async () => {
  const user = userEvent.setup()
  const { onBuildBasisChange } = renderDock()

  // The design's none-chosen state: nothing defaults to the newest variant.
  expect(screen.getByText("none chosen, all 3 stay alive")).toBeTruthy()
  expect(screen.getByText("Nothing chosen, so the agent builds on none of them.")).toBeTruthy()
  expect(screen.queryByText("✓")).toBeNull()

  await user.click(screen.getByRole("button", { name: "Build on this" }))
  expect(onBuildBasisChange).toHaveBeenLastCalledWith("replay-c")
  expect(screen.getByText("the agent builds on this one")).toBeTruthy()
  expect(screen.getByText("The others stay renderable for comparison.")).toBeTruthy()
  const chips = screen.getByRole("radiogroup", { name: "Design variants" })
  expect(within(within(chips).getByRole("radio", { name: "Variant C" })).getByText("✓")).toBeTruthy()

  // Viewing another variant keeps the choice and names it.
  await user.click(screen.getByRole("radio", { name: "Variant A" }))
  expect(screen.getByText("the agent builds on Variant C")).toBeTruthy()
  expect(screen.getByRole("button", { name: "Build on this" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Unpick" })).toBeNull()

  await user.click(screen.getByRole("radio", { name: "Variant C" }))
  await user.click(screen.getByRole("button", { name: "Unpick" }))
  expect(onBuildBasisChange).toHaveBeenLastCalledWith(undefined)
  expect(screen.getByText("none chosen, all 3 stay alive")).toBeTruthy()
  expect(screen.queryByText("✓")).toBeNull()
})

it("reads a remembered basis that no longer names a preview as none chosen", () => {
  renderDock(snapshot, "replay-gone")
  expect(screen.getByText("none chosen, all 3 stay alive")).toBeTruthy()
  expect(screen.getByRole("button", { name: "Build on this" })).toBeTruthy()
})

it("names two variants as both", () => {
  renderDock({ ...snapshot, artifacts: variants.slice(0, 2) })
  expect(screen.getByText("none chosen, both stay alive")).toBeTruthy()
})

// #810 B5.3: past the 24-variant budget the chips are a page of 24, and the
// pages reach every variant.
it("pages the chips of a group over the variant budget", async () => {
  const user = userEvent.setup()
  const many = Array.from({ length: 30 }, (_, index) => variant(`v${index + 1}`, index, index === 0 ? 2 : 1))
  renderDock({ ...snapshot, artifacts: many })
  const chips = () => within(screen.getByRole("radiogroup", { name: "Design variants" })).getAllByRole("radio")

  expect(chips()).toHaveLength(24)
  expect(screen.getByText("1-24 of 30")).toBeTruthy()
  expect((screen.getByRole("button", { name: "Earlier variants" }) as HTMLButtonElement).disabled).toBe(true)
  await user.click(screen.getByRole("button", { name: "Later variants" }))
  expect(chips()).toHaveLength(6)
  expect(screen.getByText("25-30 of 30")).toBeTruthy()
  expect(screen.getByRole("radio", { name: "Variant V30" }).getAttribute("aria-checked")).toBe("false")
  expect(screen.getByRole("radio", { name: "Variant V25" }).getAttribute("aria-checked")).toBe("true")
  expect((screen.getByRole("button", { name: "Later variants" }) as HTMLButtonElement).disabled).toBe(true)
  await user.click(screen.getByRole("button", { name: "Earlier variants" }))
  expect(chips()).toHaveLength(24)
})

// Review R1.1: a last page of one chip (25 variants) still draws the foot,
// with the way back to the earlier pages.
it("keeps the foot on a last page of one variant", async () => {
  const user = userEvent.setup()
  const many = Array.from({ length: 25 }, (_, index) => variant(`v${index + 1}`, index, index === 24 ? 2 : 1))
  renderDock({ ...snapshot, artifacts: many })

  expect(within(screen.getByRole("radiogroup", { name: "Design variants" })).getAllByRole("radio")).toHaveLength(1)
  expect(screen.getByText("25-25 of 25")).toBeTruthy()
  expect(screen.getByText("none chosen, all 25 stay alive")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Earlier variants" }))
  expect(within(screen.getByRole("radiogroup", { name: "Design variants" })).getAllByRole("radio")).toHaveLength(24)
})

// A chosen basis rides every send, so its state and Unpick stay on screen even
// when the session has nothing else to choose between.
it("keeps a chosen lone render's state and Unpick", async () => {
  const user = userEvent.setup()
  const lone: Artifact = { id: "runbook", sessionId, title: "Runbook", type: "preview", revision: 1, mimeType: "text/html", path: "previews/runbook.html" }
  const { onBuildBasisChange } = renderDock({ ...snapshot, artifacts: [lone] }, "runbook")

  expect(screen.getByText("the agent builds on this one")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Unpick" }))
  expect(onBuildBasisChange).toHaveBeenLastCalledWith(undefined)
})

// Bot review B1.1 on #824: the session's only preview can be the basis too.
it("offers Build on this for the session's only preview", async () => {
  const user = userEvent.setup()
  const lone: Artifact = { id: "runbook", sessionId, title: "Runbook", type: "preview", revision: 1, mimeType: "text/html", path: "previews/runbook.html" }
  const { onBuildBasisChange } = renderDock({ ...snapshot, artifacts: [lone] })

  expect(screen.getByText("none chosen")).toBeTruthy()
  // The notes compare a choice among several; one preview has no others.
  expect(screen.queryByText("Nothing chosen, so the agent builds on none of them.")).toBeNull()
  await user.click(screen.getByRole("button", { name: "Build on this" }))
  expect(onBuildBasisChange).toHaveBeenLastCalledWith("runbook")
  expect(screen.getByText("the agent builds on this one")).toBeTruthy()
  expect(screen.queryByText("The others stay renderable for comparison.")).toBeNull()
})

it("drafts a picked element inline under the page and posts it", async () => {
  const user = userEvent.setup()
  const { authorize, onCreateAnnotation } = renderDock()
  await waitFor(() => expect(frameTitled("Replay table C").getAttribute("src")).toContain("/artifacts/replay-c?"))
  const { frameWindow } = standInWindow(frameTitled("Replay table C"))
  const channel = authorize.mock.calls.find(([input]) => input.bridgeChannel)?.[0].bridgeChannel
  const pick = () => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "null",
      source: frameWindow,
      data: { type: "domovoi.preview.selection", channel, artifactId: "replay-c", anchor: { cssSelector: "main > table" }, label: "Replay table" },
    }))
  }

  await user.click(screen.getByRole("button", { name: "Add a comment" }))
  pick()
  const card = await screen.findByRole("region", { name: "new comment" })
  // Inline, not a dialog over the page.
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(within(card).getByText("Replay table")).toBeTruthy()
  expect(within(card).getByText("the agent reads it next turn")).toBeTruthy()
  await user.click(within(card).getByRole("button", { name: "Cancel" }))
  expect(screen.queryByRole("region", { name: "new comment" })).toBeNull()

  await user.click(screen.getByRole("button", { name: "Add a comment" }))
  pick()
  const again = await screen.findByRole("region", { name: "new comment" })
  await user.type(within(again).getByRole("textbox", { name: "Comment" }), "The expired row needs its retry time")
  await user.click(within(again).getByRole("button", { name: "Post the comment" }))
  expect(onCreateAnnotation).toHaveBeenCalledWith(expect.objectContaining({
    sessionId,
    artifactId: "replay-c",
    anchor: { cssSelector: "main > table" },
    body: "The expired row needs its retry time",
    variantId: "c",
  }))
  await waitFor(() => expect(screen.queryByRole("region", { name: "new comment" })).toBeNull())
})

it("numbers comment rows, says when an anchor no longer resolves, and offers Mark resolved", async () => {
  const user = userEvent.setup()
  const base = demoWorkspace.annotations[0]!
  const annotations: Annotation[] = [
    { ...base, id: "holds", sessionId, artifactId: "replay-c", anchor: { cssSelector: "main > table", textQuote: "claimed" }, body: "Claimed rows need a time.", status: "open", thread: [] },
    { ...base, id: "lost", sessionId, artifactId: "replay-c", anchor: { cssSelector: "main > .gone" }, body: "This row went away.", status: "open", thread: [] },
    { ...base, id: "unchecked", sessionId, artifactId: "replay-c", anchor: { cssSelector: "footer" }, body: "Footer copy.", status: "resolved", thread: [] },
  ]
  const { authorize, onSetAnnotationStatus } = renderDock({ ...snapshot, annotations })
  await waitFor(() => expect(frameTitled("Replay table C").getAttribute("src")).toContain("/artifacts/replay-c?"))
  const { frameWindow, postMessage } = standInWindow(frameTitled("Replay table C"))
  const channel = authorize.mock.calls.find(([input]) => input.bridgeChannel)?.[0].bridgeChannel
  window.dispatchEvent(new MessageEvent("message", { origin: "null", source: frameWindow, data: { type: "domovoi.preview.ready", channel, artifactId: "replay-c" } }))
  const requests = () => postMessage.mock.calls
    .filter(([message]) => (message as { type?: string }).type === "domovoi.preview.resolve-anchors")
    .map(([message]) => message as { requestId: string })
  await waitFor(() => expect(requests().length).toBeGreaterThan(0))
  // The dock answers only the request it is waiting on, the latest.
  const request = requests().at(-1)!
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "null",
      source: frameWindow,
      data: {
        type: "domovoi.preview.anchor-resolutions",
        channel,
        artifactId: "replay-c",
        requestId: request.requestId,
        resolutions: [
          { annotationId: "holds", status: "resolved", strategy: "selector" },
          { annotationId: "lost", status: "unresolved" },
          { annotationId: "unchecked", status: "resolved", strategy: "selector" },
        ],
      },
    }))
  })

  const comments = screen.getByRole("region", { name: "Comments on this preview" })
  const rows = within(comments).getAllByRole("article")
  expect(rows).toHaveLength(3)
  expect(within(rows[0]!).getByText("1")).toBeTruthy()
  expect(within(rows[0]!).getByText("anchor holds")).toBeTruthy()
  expect(within(rows[0]!).getByText("main > table")).toBeTruthy()
  expect(within(rows[0]!).getByText("claimed")).toBeTruthy()
  expect(within(rows[1]!).getByText("2")).toBeTruthy()
  expect(within(rows[1]!).getByText("anchor unavailable")).toBeTruthy()
  // An anchor that no longer resolves is not drawn as attached.
  expect(within(rows[1]!).queryByText("anchor holds")).toBeNull()
  expect(within(rows[1]!).getByText("2").getAttribute("data-anchor")).toBe("unavailable")
  expect(within(rows[0]!).getByText("1").getAttribute("data-anchor")).toBe("holds")
  expect(within(rows[2]!).getByRole("button", { name: "Reopen" })).toBeTruthy()

  await user.click(within(rows[1]!).getByRole("button", { name: "Mark resolved" }))
  expect(onSetAnnotationStatus).toHaveBeenCalledWith("lost", "resolved")
})

it("draws no anchor state before the page has answered", () => {
  const base = demoWorkspace.annotations[0]!
  renderDock({ ...snapshot, annotations: [{ ...base, id: "waiting", sessionId, artifactId: "replay-c", anchor: { cssSelector: "main" }, thread: [] }] })
  const row = within(screen.getByRole("region", { name: "Comments on this preview" })).getByRole("article")
  expect(within(row).queryByText("anchor holds")).toBeNull()
  expect(within(row).queryByText("anchor unavailable")).toBeNull()
  expect(within(row).getByText("1").getAttribute("data-anchor")).toBe("unknown")
})
