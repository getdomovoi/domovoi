import { demoWorkspace, type ProviderModel, type SessionAttachment } from "@getdomovoi/protocol"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps, ReactNode } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { WorkspaceConnectionProvider } from "./connection-status"
import { emptySessionDraft, sessionDraftStore } from "./session-draft"
import type { QueuedMessage } from "./turn-queue"
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
