import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { demoWorkspace, type Artifact, type ArtifactAccess, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { ArtifactDock } from "./artifact-dock"

const sessionId = demoWorkspace.activeSessionId!
const artifacts: Artifact[] = [
  {
    id: "runbook",
    sessionId,
    title: "Duplicate-delivery runbook",
    type: "preview",
    revision: 2,
    mimeType: "text/html",
    path: ".domovoi/previews/runbook.html",
  },
  {
    id: "replay-a",
    sessionId,
    title: "Replay table A",
    type: "preview",
    revision: 1,
    mimeType: "text/html",
    path: "design-studio/replay/a.html",
    variant: { groupId: "replay", id: "a", label: "Variant A", order: 1 },
  },
  {
    id: "replay-b",
    sessionId,
    title: "Replay table B",
    type: "preview",
    revision: 3,
    mimeType: "text/html",
    path: "design-studio/replay/b.html",
    variant: { groupId: "replay", id: "b", label: "Variant B", order: 2 },
  },
]
const snapshot: WorkspaceSnapshot = { ...demoWorkspace, artifacts, annotations: [] }

type AuthorizeInput = Parameters<Parameters<typeof ArtifactDock>[0]["authorizeArtifact"]>[0]

function grantingAuthorize(lifetimeSeconds = 60) {
  let issued = 0
  return vi.fn(async (input: AuthorizeInput): Promise<ArtifactAccess> => {
    issued += 1
    return {
      sessionId: input.sessionId,
      artifactId: input.artifactId,
      revision: input.revision,
      purpose: input.purpose,
      ...(input.bridgeChannel ? { bridgeChannel: input.bridgeChannel } : {}),
      ...(input.parentOrigin ? { parentOrigin: input.parentOrigin } : {}),
      expiresAt: Date.now() / 1_000 + lifetimeSeconds,
      signature: `grant-${issued}`,
    }
  })
}

function renderDock(
  authorizeArtifact: ReturnType<typeof grantingAuthorize>,
  onCreateAnnotation = vi.fn(async () => {}),
  dockSnapshot: WorkspaceSnapshot = snapshot,
  captureAnnotation?: Parameters<typeof ArtifactDock>[0]["captureAnnotation"],
) {
  render(
    <ArtifactDock
      {...(captureAnnotation ? { captureAnnotation } : {})}
      snapshot={dockSnapshot}
      onCollapse={vi.fn()}
      defaultTab="preview"
      rpcUrl="ws://127.0.0.1:47831/rpc"
      authorizeArtifact={authorizeArtifact}
      connected
      terminalControls={{ claim: vi.fn(), release: vi.fn(), write: vi.fn(), resize: vi.fn() } as never}
      onReplyToAnnotation={vi.fn()}
      onSetAnnotationStatus={vi.fn()}
      onCreateAnnotation={onCreateAnnotation}
      onLoadSessionHistory={vi.fn()}
      onLoadSessionEvidence={vi.fn()}
      onRevertSessionFile={vi.fn()}
    />,
  )
  return { onCreateAnnotation }
}

function frameTitled(title: string): HTMLIFrameElement {
  const frame = screen.getByTitle(title)
  if (!(frame instanceof HTMLIFrameElement)) throw new Error(`${title} is not a frame`)
  return frame
}

function expectSandboxed(frame: HTMLIFrameElement) {
  expect(frame.getAttribute("sandbox"), frame.title).toBe("allow-scripts")
  expect(frame.getAttribute("referrerpolicy"), frame.title).toBe("no-referrer")
}

const happyDom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM
let loadedFrames: boolean | undefined

beforeEach(() => {
  // The frames only need their attributes and windows, not their pages fetched.
  loadedFrames = happyDom?.settings.disableIframePageLoading
  if (happyDom) happyDom.settings.disableIframePageLoading = true
})

afterEach(() => {
  cleanup()
  if (happyDom && loadedFrames !== undefined) happyDom.settings.disableIframePageLoading = loadedFrames
})

it("opens a preview rendered earlier in the session from the list", async () => {
  const user = userEvent.setup()
  const authorize = grantingAuthorize()
  renderDock(authorize)

  const list = screen.getByRole("navigation", { name: "Rendered this session" })
  expect(within(list).getByText("RENDERED THIS SESSION")).toBeTruthy()
  const rows = within(list).getAllByRole("button")
  expect(rows.map((row) => row.textContent)).toEqual([
    "Duplicate-delivery runbook.domovoi/previews · revision 2",
    "replaydesign-studio · 2 variants",
  ])
  expect(rows[1]?.getAttribute("aria-current")).toBe("true")

  await user.click(rows[0]!)

  expect(rows[0]?.getAttribute("aria-current")).toBe("true")
  await waitFor(() => expect(frameTitled("Duplicate-delivery runbook").getAttribute("src")).toContain("/artifacts/runbook?"))
  expectSandboxed(frameTitled("Duplicate-delivery runbook"))
  expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ artifactId: "runbook", revision: 2, purpose: "preview" }))
})

it("draws the design's toolbar and keeps the shipped extras behind one overflow control", async () => {
  const user = userEvent.setup()
  renderDock(grantingAuthorize(42))

  expect(await screen.findByText(/^authorized · \d+s left$/u)).toBeTruthy()
  const widths = screen.getByRole("radiogroup",{ name: "Preview device width" })
  expect(within(widths).getAllByRole("radio").map((width) => width.textContent)).toEqual(["sm", "md", "lg"])
  expect(within(widths).getByRole("radio", { name: "Full width preview" }).getAttribute("aria-checked")).toBe("true")
  expect(screen.queryByRole("button", { name: "Open sanitized print view" })).toBeNull()
  expect(screen.queryByText("Live")).toBeNull()

  await user.click(within(widths).getByRole("radio", { name: "390 pixel preview" }))
  expect(frameTitled("Replay table B").style.maxWidth).toBe("390px")

  const annotate = screen.getByRole("button", { name: "Add a comment" })
  await user.click(annotate)
  expect(annotate.getAttribute("aria-pressed")).toBe("true")
  expect(annotate.textContent).toBe("Click an element")
  expect(screen.getByText("Click an element in the preview to comment on it.")).toBeTruthy()

  await user.click(screen.getByRole("button", { name: "More preview actions" }))
  const menu = await screen.findByRole("menu")
  expect(within(menu).getByRole("menuitem", { name: "Open sanitized print view" })).toBeTruthy()
  expect(within(menu).getByRole("menuitem", { name: "Download sanitized offline HTML copy" })).toBeTruthy()
  expect(within(menu).getByRole("menuitemcheckbox", { name: "Compare" })).toBeTruthy()
  expect(within(menu).getByRole("menuitemcheckbox", { name: "Variant thumbnails" })).toBeTruthy()
  expect(within(menu).getByText("Safe copies remove scripts, forms, and external assets.")).toBeTruthy()
  expect(within(menu).getByText("Live · reloads when the agent renders a new revision")).toBeTruthy()

  // A floating sheet closes on an Escape that reaches the document; closing
  // the menu must not take the sheet with it.
  const sheetEscape = vi.fn()
  document.addEventListener("keydown", sheetEscape)
  try {
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(sheetEscape).not.toHaveBeenCalled()
  } finally {
    document.removeEventListener("keydown", sheetEscape)
  }
})

it("renews the grant before it lapses without reloading the page on screen", async () => {
  const user = userEvent.setup()
  // Six seconds is one past the renewal lead, so the renewal is due in one.
  const authorize = grantingAuthorize(6)
  renderDock(authorize)

  await waitFor(() => expect(frameTitled("Replay table B").getAttribute("src")).toContain("signature=grant-1"))
  await waitFor(() => expect(authorize.mock.calls.filter(([input]) => input.purpose === "preview" && input.bridgeChannel).length).toBeGreaterThan(1), { timeout: 3_000 })
  expect(frameTitled("Replay table B").getAttribute("src")).toContain("signature=grant-1")

  await user.click(screen.getByRole("button", { name: "Open fullscreen preview" }))
  const fullscreen = frameTitled("Replay table B fullscreen")
  expect(fullscreen.getAttribute("src")).toMatch(/signature=grant-[2-9]/u)
  expectSandboxed(fullscreen)
})

it("signs no grants while the preview is hidden and loads a fresh one when it shows again", async () => {
  const user = userEvent.setup()
  const authorize = grantingAuthorize(6)
  renderDock(authorize)
  const bridged = () => authorize.mock.calls.filter(([input]) => input.bridgeChannel).length
  await waitFor(() => expect(frameTitled("Replay table B").getAttribute("src")).toContain("signature=grant-1"))

  await user.click(screen.getByRole("tab", { name: "Rules" }))
  const hiddenAt = bridged()
  // Past the first grant's renewal point: shown, it would have been renewed.
  await new Promise((resolve) => setTimeout(resolve, 1_300))
  expect(bridged()).toBe(hiddenAt)

  await user.click(screen.getByRole("tab", { name: "Preview" }))
  await waitFor(() => expect(bridged()).toBeGreaterThan(hiddenAt))
  await waitFor(() => expect(frameTitled("Replay table B").getAttribute("src")).not.toContain("signature=grant-1"))
  expect(frameTitled("Replay table B").getAttribute("src")).toMatch(/signature=grant-\d+/u)
  expectSandboxed(frameTitled("Replay table B"))
})

// Page loading is off, so a frame has no window of its own; this one stands
// in for the sandboxed page on the other end of the bridge.
function standInWindow(frame: HTMLIFrameElement) {
  const postMessage = vi.fn()
  const frameWindow = { postMessage } as unknown as Window
  Object.defineProperty(frame, "contentWindow", { configurable: true, get: () => frameWindow })
  return { frameWindow, postMessage }
}

it("resolves comment anchors in a fullscreen frame each time fullscreen opens", async () => {
  const user = userEvent.setup()
  const authorize = grantingAuthorize()
  const annotation = {
    ...demoWorkspace.annotations[0]!,
    id: "annotation-on-b",
    sessionId,
    artifactId: "replay-b",
    anchor: { cssSelector: "main > table" },
    thread: [],
  }
  renderDock(authorize, undefined, { ...snapshot, annotations: [annotation] })
  await waitFor(() => expect(frameTitled("Replay table B").getAttribute("src")).toContain("/artifacts/replay-b?"))
  const channel = authorize.mock.calls.find(([input]) => input.bridgeChannel)?.[0].bridgeChannel
  const ready = { type: "domovoi.preview.ready", channel, artifactId: "replay-b" }
  const resolveRequests = (postMessage: ReturnType<typeof vi.fn>) => postMessage.mock.calls
    .filter(([message]) => (message as { type?: string }).type === "domovoi.preview.resolve-anchors")

  for (const round of [1, 2]) {
    await user.click(screen.getByRole("button", { name: "Open fullscreen preview" }))
    const { frameWindow, postMessage } = standInWindow(frameTitled("Replay table B fullscreen"))
    window.dispatchEvent(new MessageEvent("message", { origin: "null", source: frameWindow, data: ready }))
    await waitFor(() => expect(resolveRequests(postMessage), `round ${round}`).toHaveLength(1))
    expect(resolveRequests(postMessage)[0]?.[0]).toMatchObject({ artifactId: "replay-b", annotations: [{ annotationId: "annotation-on-b" }] })
    await user.click(screen.getByRole("button", { name: "Exit fullscreen" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  }
})

it("annotates in fullscreen, with the draft posted from the comments column", async () => {
  const user = userEvent.setup()
  const authorize = grantingAuthorize()
  const { onCreateAnnotation } = renderDock(authorize)
  await waitFor(() => expect(frameTitled("Replay table B").getAttribute("src")).toContain("/artifacts/replay-b?"))

  await user.click(screen.getByRole("button", { name: "Open fullscreen preview" }))
  const surface = screen.getByRole("dialog")
  expect(within(surface).getByText("design-studio/replay/b.html · read-only")).toBeTruthy()
  expect(within(surface).getByText("esc")).toBeTruthy()
  expect(within(within(surface).getByRole("radiogroup",{ name: "Preview device width" })).getAllByRole("radio")).toHaveLength(3)
  expect(within(surface).getByRole("radiogroup",{ name: "Design variants" })).toBeTruthy()
  const column = within(surface).getByRole("complementary", { name: "Comments on Variant B" })

  const frame = frameTitled("Replay table B fullscreen")
  expectSandboxed(frame)
  // Page loading is off, so the frame has no window of its own; this one
  // stands in for the sandboxed page on the other end of the bridge.
  const posted = vi.fn()
  const frameWindow = { postMessage: posted } as unknown as Window
  Object.defineProperty(frame, "contentWindow", { configurable: true, get: () => frameWindow })
  await user.click(within(column).getByRole("button", { name: "Add a comment" }))
  const channel = authorize.mock.calls.find(([input]) => input.bridgeChannel)?.[0].bridgeChannel
  expect(posted).toHaveBeenCalledWith({ type: "domovoi.preview.picker", channel, active: true }, "*")

  window.dispatchEvent(new MessageEvent("message", {
    origin: "null",
    source: frameWindow,
    data: {
      type: "domovoi.preview.selection",
      channel,
      artifactId: "replay-b",
      anchor: { cssSelector: "main > table" },
      label: "Replay table",
    },
  }))

  const draft = await within(column).findByRole("textbox", { name: "Comment" })
  expect(screen.queryByText("Annotate preview")).toBeNull()
  await user.type(draft, "The expired row needs its retry time")
  await user.click(within(column).getByRole("button", { name: "Post" }))

  expect(onCreateAnnotation).toHaveBeenCalledWith(expect.objectContaining({
    sessionId,
    artifactId: "replay-b",
    anchor: { cssSelector: "main > table" },
    body: "The expired row needs its retry time",
    variantId: "b",
  }))
  await waitFor(() => expect(within(column).queryByRole("textbox", { name: "Comment" })).toBeNull())

  // esc leaves fullscreen for the dock; it does not also close the sheet.
  const sheetEscape = vi.fn()
  document.addEventListener("keydown", sheetEscape)
  try {
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(sheetEscape).not.toHaveBeenCalled()
    expect(frameTitled("Replay table B")).toBeTruthy()
  } finally {
    document.removeEventListener("keydown", sheetEscape)
  }
})

it("opens the draft once the desktop's visual capture of the picked element lands, in fullscreen and in the dock", async () => {
  const user = userEvent.setup()
  const authorize = grantingAuthorize()
  // The capture resolves on a later task, after the picker has been turned
  // off and the dock has rendered again, as the desktop's capture does.
  const capture = vi.fn((rect: { x: number, y: number, width: number, height: number }) =>
    new Promise<{ mimeType: "image/png", width: number, height: number, data: string }>((resolve) => {
      setTimeout(() => resolve({ mimeType: "image/png", width: rect.width, height: rect.height, data: "iVBORw0KGgo=" }), 20)
    }))
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, width: 800, height: 600, right: 800, bottom: 600, toJSON: () => ({}),
  } as DOMRect)
  try {
    const { onCreateAnnotation } = renderDock(authorize, undefined, snapshot, capture)
    await waitFor(() => expect(frameTitled("Replay table B").getAttribute("src")).toContain("/artifacts/replay-b?"))
    const channel = authorize.mock.calls.find(([input]) => input.bridgeChannel)?.[0].bridgeChannel
    const selection = {
      type: "domovoi.preview.selection",
      channel,
      artifactId: "replay-b",
      anchor: { cssSelector: "main > table", bbox: { x: 10, y: 10, width: 120, height: 40 } },
      label: "Replay table",
    }

    await user.click(screen.getByRole("button", { name: "Open fullscreen preview" }))
    const column = within(screen.getByRole("dialog")).getByRole("complementary", { name: "Comments on Variant B" })
    const full = standInWindow(frameTitled("Replay table B fullscreen"))
    await user.click(within(column).getByRole("button", { name: "Add a comment" }))
    window.dispatchEvent(new MessageEvent("message", { origin: "null", source: full.frameWindow, data: selection }))
    const draft = await within(column).findByRole("textbox", { name: "Comment" })
    expect(capture).toHaveBeenCalledTimes(1)
    await user.type(draft, "Too tight")
    await user.click(within(column).getByRole("button", { name: "Post" }))
    expect(onCreateAnnotation).toHaveBeenLastCalledWith(expect.objectContaining({
      body: "Too tight",
      visualContextUpload: expect.objectContaining({ mimeType: "image/png", artifactRevision: 3 }),
    }))
    await user.click(screen.getByRole("button", { name: "Exit fullscreen" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    const dock = standInWindow(frameTitled("Replay table B"))
    await user.click(screen.getByRole("button", { name: "Add a comment" }))
    window.dispatchEvent(new MessageEvent("message", { origin: "null", source: dock.frameWindow, data: selection }))
    expect(await screen.findByRole("dialog", { name: "Annotate preview" })).toBeTruthy()
    expect(capture).toHaveBeenCalledTimes(2)
  } finally {
    bounds.mockRestore()
  }
})
