import { demoWorkspace, type ProviderModel, type SessionAttachment } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps, ReactNode } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { WorkspaceConnectionProvider } from "./connection-status"
import { emptySessionDraft, sessionDraftStore } from "./session-draft"
import { failedAttempt, type QueuedMessage } from "./turn-queue"
import { Thread } from "./workspace-shell.js"

afterEach(() => {
  cleanup()
  for (const session of demoWorkspace.sessions) sessionDraftStore.clear(session.id)
})

const machine = demoWorkspace.machine.name
const activeId = demoWorkspace.activeSessionId!
// Eight bytes, the PNG signature: enough for a chip and a send.
const image: SessionAttachment = { mimeType: "image/png", width: 2, height: 2, data: "iVBORw0KGgo=" }
const notes: SessionAttachment = { kind: "workspace-file", path: "src/notes.ts" }

function sonnet(imageInput: boolean | undefined): ProviderModel {
  return {
    provider: "claude-code",
    id: "sonnet-4.6",
    displayName: "Sonnet 4.6",
    description: "",
    supportedReasoningEfforts: [],
    isDefault: true,
    ...(imageInput === undefined ? {} : { imageInput }),
  }
}

function renderThread({
  imageInput,
  draft = [],
  prompt = "",
  onSend = vi.fn(async () => {}),
  wrap = (node) => node,
  queued,
  onQueuedChange = vi.fn(),
}: {
  imageInput: boolean | undefined
  draft?: SessionAttachment[]
  prompt?: string
  onSend?: ComponentProps<typeof Thread>["onSend"]
  wrap?: (node: ReactNode) => ReactNode
  queued?: QueuedMessage
  onQueuedChange?: (next: QueuedMessage | undefined) => void
}) {
  sessionDraftStore.write(activeId, { ...emptySessionDraft, prompt, attachments: draft })
  const onListModels = vi.fn(async (provider: string) => provider === "claude-code" ? [sonnet(imageInput)] : [])
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  render(wrap(
    <Thread
      snapshot={snapshot}
      connected
      queued={queued}
      onQueuedChange={onQueuedChange}
      onResolve={vi.fn(async () => {})}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={onListModels}
      onNewSession={vi.fn()}
      onSend={onSend}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
    />,
  ))
  return { onSend, onListModels }
}

const notice = () => screen.queryByRole("group", { name: "Images this model cannot take" })
const send = () => screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement

it("locks send and says which images cannot go to a model that takes none", async () => {
  const user = userEvent.setup()
  const { onSend } = renderThread({ imageInput: false, draft: [image, notes], prompt: "Look at this" })

  await waitFor(() => expect(notice()).not.toBeNull())
  expect(notice()!.textContent).toContain("1 image cannot go to sonnet-4.6. Remove it or pick another model.")
  const chip = within(screen.getByRole("region", { name: "Attachments" })).getByText("image.png").closest("li")!
  expect(chip.className).toContain("border-danger-border")
  expect(within(chip).getByText("no image input")).toBeTruthy()
  expect(send().disabled).toBe(true)

  await user.click(screen.getByRole("textbox", { name: "Message" }))
  await user.keyboard("{Enter}")
  expect(onSend).not.toHaveBeenCalled()
})

// A message queued before the model's answer arrived, or before a model
// change, would go out at the turn boundary and be refused there. It is held
// instead, whole, and its Send stays off while the model takes no images.
it("holds a queued message with images once the model is known to take none", async () => {
  const onQueuedChange = vi.fn()
  const queued: QueuedMessage = { sessionId: activeId, text: "With a screenshot", state: "waiting", attachments: [image] }
  renderThread({ imageInput: false, queued, onQueuedChange })

  await waitFor(() => expect(onQueuedChange).toHaveBeenCalledWith({
    ...queued,
    state: "held",
    reason: "Held because sonnet-4.6 takes no image input. Change the model, or unqueue it and attach again without the images.",
  }))
})

it("keeps a held queued message with images from being sent to that model", async () => {
  const queued: QueuedMessage = { sessionId: activeId, text: "With a screenshot", state: "held", reason: "Held", attachments: [image] }
  renderThread({ imageInput: false, queued })

  const row = screen.getByText("With a screenshot").parentElement!
  await waitFor(() => expect((within(row).getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true))
})

it("leaves a queued message alone when the model takes images or has not said", async () => {
  const onQueuedChange = vi.fn()
  const queued: QueuedMessage = { sessionId: activeId, text: "With a screenshot", state: "waiting", attachments: [image] }
  renderThread({ imageInput: undefined, queued, onQueuedChange })
  await screen.findByRole("button", { name: "Attach" })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(onQueuedChange).not.toHaveBeenCalled()
})

// The editor covers the composer, so it says the same thing itself.
it("says in the prompt editor which images cannot go to the model", async () => {
  const user = userEvent.setup()
  renderThread({ imageInput: false, draft: [image], prompt: "Look" })

  await waitFor(() => expect(notice()).not.toBeNull())
  await user.click(screen.getByRole("button", { name: "Expand prompt editor" }))
  const editor = await screen.findByRole("dialog", { name: "Prompt editor" })
  expect(within(editor).getByText("1 image cannot go to sonnet-4.6. Remove it or pick another model.")).toBeTruthy()
  expect(within(within(editor).getByRole("region", { name: "Attachments" })).getByText("no image input")).toBeTruthy()
  expect((within(editor).getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true)
})

// The model menu reads the catalog afresh each time it opens. What it reads
// about the session's model is what the composer locks on, so a first read
// that failed, or an answer that has since changed, does not leave images
// sendable.
it("locks on the model menu's fresh answer when the first read failed", async () => {
  const user = userEvent.setup()
  sessionDraftStore.write(activeId, { ...emptySessionDraft, prompt: "Look", attachments: [image] })
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  snapshot.machine.providers = [{ id: "claude-code", command: "claude", status: "ready", sessionCapable: true }]
  const onListModels = vi.fn()
    .mockRejectedValueOnce(new Error("not yet"))
    .mockResolvedValue([sonnet(false)])
  render(
    <Thread
      snapshot={snapshot}
      connected
      onQueuedChange={vi.fn()}
      onResolve={vi.fn(async () => {})}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={onListModels}
      onNewSession={vi.fn()}
      onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
    />,
  )
  await waitFor(() => expect(onListModels).toHaveBeenCalledTimes(1))
  expect(notice()).toBeNull()

  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/u }))

  await waitFor(() => expect(notice()).not.toBeNull())
  expect(send().disabled).toBe(true)
})

// A release the daemon refused (an image for a model that takes none, among
// others) leaves a failed row. The row keeps the message's attachments, so
// queueing it again after a model change sends what the person attached.
it("keeps a failed send's attachments and queues them again", async () => {
  const user = userEvent.setup()
  const attempt = failedAttempt("attempt-1", { sessionId: activeId, text: "With a screenshot", state: "waiting", attachments: [image] }, {
    refused: true, answered: true, reason: "1 image cannot go to sonnet-4.6",
  })
  expect(attempt.attachments).toEqual([image])
  const onQueuedChange = vi.fn()
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  render(
    <Thread
      snapshot={snapshot}
      connected
      failures={[attempt]}
      onQueuedChange={onQueuedChange}
      onResolve={vi.fn(async () => {})}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => [sonnet(true)])}
      onNewSession={vi.fn()}
      onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
    />,
  )

  await user.click(screen.getByRole("button", { name: "Queue again" }))
  expect(onQueuedChange).toHaveBeenCalledWith({ sessionId: activeId, text: "With a screenshot", state: "waiting", attachments: [image] })
})

// The menu's answer is newer than a read still pending from mount; the late
// read does not undo the lock the menu's answer set.
it("keeps the menu's answer when an older read settles after it", async () => {
  const user = userEvent.setup()
  sessionDraftStore.write(activeId, { ...emptySessionDraft, prompt: "Look", attachments: [image] })
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  snapshot.machine.providers = [{ id: "claude-code", command: "claude", status: "ready", sessionCapable: true }]
  let settleFirst: (models: ProviderModel[]) => void = () => {}
  const onListModels = vi.fn()
    .mockImplementationOnce(() => new Promise<ProviderModel[]>((resolve) => { settleFirst = resolve }))
    .mockResolvedValue([sonnet(false)])
  render(
    <Thread
      snapshot={snapshot}
      connected
      onQueuedChange={vi.fn()}
      onResolve={vi.fn(async () => {})}
      onSetRuntime={vi.fn(async () => {})}
      onForkSession={vi.fn(async () => {})}
      onListModels={onListModels}
      onNewSession={vi.fn()}
      onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
    />,
  )
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/u }))
  await waitFor(() => expect(notice()).not.toBeNull())

  await act(async () => { settleFirst([sonnet(true)]) })

  expect(notice()).not.toBeNull()
  expect(send().disabled).toBe(true)
})

// Reads are ordered by when they started, not when they answer: a menu read
// for codex started before the session moved to codex is older than the
// thread's read on the move, and does not replace it when it answers last.
it("keeps a newer read's answer over a menu read that started before a harness change", async () => {
  const user = userEvent.setup()
  sessionDraftStore.write(activeId, { ...emptySessionDraft, prompt: "Look", attachments: [image] })
  const snapshot = structuredClone(demoWorkspace)
  snapshot.approvals = []
  snapshot.machine.providers = [
    { id: "claude-code", command: "claude", status: "ready", sessionCapable: true },
    { id: "codex", command: "codex", status: "ready", sessionCapable: true },
  ]
  const codex = (imageInput: boolean): ProviderModel => ({ ...sonnet(imageInput), provider: "codex", id: "gpt-5.3-codex" })
  let menuCodex: (models: ProviderModel[]) => void = () => {}
  let codexReads = 0
  const onListModels = vi.fn((provider: string) => {
    if (provider === "claude-code") return Promise.resolve([sonnet(true)])
    codexReads += 1
    // The first codex read is the menu's, left pending; the next is the thread's.
    return codexReads === 1
      ? new Promise<ProviderModel[]>((resolve) => { menuCodex = resolve })
      : Promise.resolve([codex(false)])
  })
  const props = {
    connected: true,
    onQueuedChange: vi.fn(),
    onResolve: vi.fn(async () => {}),
    onSetRuntime: vi.fn(async () => {}),
    onForkSession: vi.fn(async () => {}),
    onListModels,
    onNewSession: vi.fn(),
    onSend: vi.fn(async () => {}),
    onCheckpoint: vi.fn(async () => {}),
    onRestoreCheckpoint: vi.fn(async () => {}),
    onPauseSession: vi.fn(async () => {}),
  }
  const { rerender } = render(<Thread snapshot={snapshot} {...props} />)
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/u }))
  await waitFor(() => expect(codexReads).toBe(1))

  const moved = structuredClone(snapshot)
  moved.sessions.find((session) => session.id === activeId)!.runtime = { ...moved.sessions.find((session) => session.id === activeId)!.runtime, provider: "codex", model: "gpt-5.3-codex" }
  rerender(<Thread snapshot={moved} {...props} />)
  await waitFor(() => expect(notice()).not.toBeNull())

  await act(async () => { menuCodex([codex(true)]) })

  expect(notice()).not.toBeNull()
})

it("names the count when several images are locked", async () => {
  renderThread({ imageInput: false, draft: [image, image], prompt: "Both" })

  await waitFor(() => expect(notice()).not.toBeNull())
  expect(notice()!.textContent).toContain("2 images cannot go to sonnet-4.6. Remove them or pick another model.")
  expect(within(notice()!).getByRole("button", { name: "Remove 2 images" })).toBeTruthy()
})

it("removes the locked images and keeps everything else", async () => {
  const user = userEvent.setup()
  const { onSend } = renderThread({ imageInput: false, draft: [image, notes], prompt: "Without the image" })

  await waitFor(() => expect(notice()).not.toBeNull())
  await user.click(within(notice()!).getByRole("button", { name: "Remove image" }))

  expect(notice()).toBeNull()
  await user.click(send())
  expect(onSend).toHaveBeenCalledWith(activeId, "Without the image", undefined, [notes])
})

it("opens the model menu from Change model", async () => {
  const user = userEvent.setup()
  renderThread({ imageInput: false, draft: [image], prompt: "x" })

  await waitFor(() => expect(notice()).not.toBeNull())
  await user.click(within(notice()!).getByRole("button", { name: "Change model" }))

  expect(await screen.findByRole("listbox", { name: "Models" })).toBeTruthy()
})

// Not knowing is not no: an absent imageInput never locks. The phone's line
// says what happens if the model turns out to take none.
it("sends images when the harness has not said, and says what is not known", async () => {
  const user = userEvent.setup()
  const { onSend } = renderThread({ imageInput: undefined, draft: [image], prompt: "Maybe" })

  expect(await screen.findByText("Domovoi does not know whether sonnet-4.6 takes image input. If it does not, the machine refuses the send and nothing is sent.")).toBeTruthy()
  expect(notice()).toBeNull()
  await user.click(send())
  expect(onSend).toHaveBeenCalledWith(activeId, "Maybe", undefined, [image])
})

it("locks the device source in the attach menu and names the model's image input", async () => {
  const user = userEvent.setup()
  renderThread({ imageInput: false })

  // The menu reads the answer the thread already has.
  await waitFor(() => expect(screen.getByRole("button", { name: "Attach" })).toBeTruthy())
  await user.click(screen.getByRole("button", { name: "Attach" }))
  const menu = await screen.findByRole("menu")
  await waitFor(() => expect(within(menu).getByText("Locked for this model.")).toBeTruthy())
  const device = within(menu).getByRole("menuitem", { name: /Image or file from this device/u })
  expect(device.getAttribute("aria-disabled")).toBe("true")
  expect(within(device).getByText(`refused by ${machine} · attach.image.model_no_input`)).toBeTruthy()
  const footer = within(menu).getByRole("group", { name: "The model this message goes to" })
  expect(within(footer).getByText("sonnet-4.6")).toBeTruthy()
  expect(within(footer).getByText("takes no image input, as its harness reports")).toBeTruthy()
})

it("keeps the device source open for a model that takes images", async () => {
  const user = userEvent.setup()
  renderThread({ imageInput: true })

  await user.click(screen.getByRole("button", { name: "Attach" }))
  const menu = await screen.findByRole("menu")
  const footer = within(menu).getByRole("group", { name: "The model this message goes to" })
  await waitFor(() => expect(within(footer).getByText("takes image input, as its harness reports")).toBeTruthy())
  const device = within(menu).getByRole("menuitem", { name: /Image or file from this device/u })
  expect(device.getAttribute("aria-disabled")).toBeNull()
  expect(within(device).getByText("PNG")).toBeTruthy()
  expect(within(menu).queryByText("Locked for this model.")).toBeNull()
})

it("says image input is not known until the harness says", async () => {
  const user = userEvent.setup()
  renderThread({ imageInput: undefined })

  await user.click(screen.getByRole("button", { name: "Attach" }))
  const footer = within(await screen.findByRole("menu")).getByRole("group", { name: "The model this message goes to" })
  expect(within(footer).getByText("image input not known")).toBeTruthy()
})

// "That is this computer, so nothing leaves it" is a claim about where the
// bytes go. Only the desktop app's own daemon on this machine makes it; a
// browser on a loopback address may be an SSH forward, and an attached
// machine is somewhere else.
const connection = (endpoint: string | undefined) => (node: ReactNode) => (
  <WorkspaceConnectionProvider
    connected
    reconnecting={false}
    authenticationRequired={null}
    protocolError={null}
    connectionError=""
    machineName={machine}
    machineId={demoWorkspace.machine.id}
    endpoint={endpoint}
    onReconnect={vi.fn()}
  >
    {node}
  </WorkspaceConnectionProvider>
)

async function deviceNote(wrap: (node: ReactNode) => ReactNode) {
  const user = userEvent.setup()
  renderThread({ imageInput: true, wrap })
  await user.click(screen.getByRole("button", { name: "Attach" }))
  return within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Image or file from this device/u }).textContent
}

it("says nothing leaves this computer only for the desktop app's own daemon", async () => {
  expect(await deviceNote(connection("ws://127.0.0.1:47831/rpc"))).toContain(`It is copied to ${machine}. That is this computer, so nothing leaves it.`)
})

it("keeps the plain copy note for a browser or an attached machine", async () => {
  // The shell passes no endpoint for either.
  const note = await deviceNote(connection(undefined))
  expect(note).toContain(`The selected file is copied to ${machine} with the next message.`)
  expect(note).not.toContain("nothing leaves it")
})

it("keeps the plain copy note without a connection to read", async () => {
  expect(await deviceNote((node) => node)).toContain(`The selected file is copied to ${machine} with the next message.`)
})
