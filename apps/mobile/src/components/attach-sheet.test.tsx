import { describe, expect, it, jest } from "@jest/globals"
import { act, fireEvent, render, screen } from "@testing-library/react-native"
import { Platform } from "react-native"

import { AttachSheet } from "./attach-sheet"

async function draw(overrides: Partial<Parameters<typeof AttachSheet>[0]> = {}) {
  const props = {
    open: true,
    machine: "mac-mini-m4",
    problem: "",
    onPickLibrary: jest.fn<() => void>(),
    onTakePhoto: jest.fn<() => void>(),
    onClose: jest.fn<() => void>(),
    ...overrides,
  }
  await render(<AttachSheet {...props} />)
  return props
}

// What iOS reports once the sheet's slide-out has finished.
async function dismissed() {
  const sheet = screen.getByTestId("attach-sheet")
  await act(async () => {
    (sheet.props as { onDismiss: () => void }).onDismiss()
  })
}

describe("AttachSheet", () => {
  it("offers the two image sources with the bound, and names what the other three wait on", async () => {
    const props = await draw()

    expect(screen.getByText("up to 1.5 MB and 2048 px, uploaded to mac-mini-m4 and not stored here")).toBeOnTheScreen()
    expect(screen.getByText("one shot, sent with the turn, same bound")).toBeOnTheScreen()
    for (const waits of [
      "desktop work: a phone holds no worktree to pick from",
      // A phone reads a terminal since frame 04; picking output to attach
      // is what is not built (the design's open question 5).
      "not built: a phone reads a terminal but cannot pick its output to attach",
      "not built: an outbound fetch on a phone's word needs its own gate line",
    ]) expect(screen.getByText(waits)).toBeOnTheScreen()
    expect(screen.queryByText(/which a phone does not have yet/)).toBeNull()
    // The three that wait are stated, not tappable.
    expect(screen.queryByRole("button", { name: /File from the worktree/ })).toBeNull()

    await fireEvent.press(screen.getByRole("button", { name: /Photo or screenshot/ }))
    await dismissed()
    await fireEvent.press(screen.getByRole("button", { name: /Take a photo/ }))
    await dismissed()
    expect(props.onPickLibrary).toHaveBeenCalledTimes(1)
    expect(props.onTakePhoto).toHaveBeenCalledTimes(1)
  })

  // Walk F23: iOS will not present the photo library while this sheet is
  // still on screen, and said nothing when asked to. The sheet closes first
  // and the picker opens once iOS reports the sheet gone.
  it("opens a picker only after the sheet has gone", async () => {
    const props = await draw()

    await fireEvent.press(screen.getByRole("button", { name: /Photo or screenshot/ }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onPickLibrary).not.toHaveBeenCalled()
    await dismissed()
    expect(props.onPickLibrary).toHaveBeenCalledTimes(1)
    // A dismissal with nothing chosen opens nothing.
    await dismissed()
    expect(props.onPickLibrary).toHaveBeenCalledTimes(1)

    // A second attempt works the same way, and the later choice is the one taken.
    await fireEvent.press(screen.getByRole("button", { name: /Photo or screenshot/ }))
    await fireEvent.press(screen.getByRole("button", { name: /Take a photo/ }))
    await dismissed()
    expect(props.onPickLibrary).toHaveBeenCalledTimes(1)
    expect(props.onTakePhoto).toHaveBeenCalledTimes(1)
  })

  // Android has no such conflict and no dismissal callback, so it opens at once.
  it("opens a picker at once where the platform reports no dismissal", async () => {
    jest.replaceProperty(Platform, "OS", "android")
    const props = await draw()
    await fireEvent.press(screen.getByRole("button", { name: /Take a photo/ }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onTakePhoto).toHaveBeenCalledTimes(1)
    jest.restoreAllMocks()
  })

  // Frame 13: the model line says what the session's model takes, as its
  // harness reports, and both image sources stay open.
  it("names a model that takes images and keeps both sources open", async () => {
    const props = await draw({ images: { model: "claude-sonnet-4.6", imageInput: true } })

    expect(screen.getByText("claude-sonnet-4.6")).toBeOnTheScreen()
    expect(screen.getByText("takes image input, as its harness reports")).toBeOnTheScreen()
    expect(screen.queryByText("Locked for this model.")).toBeNull()
    await fireEvent.press(screen.getByRole("button", { name: /Take a photo/ }))
    await dismissed()
    expect(props.onTakePhoto).toHaveBeenCalledTimes(1)
  })

  // Frame 13b (guard A): a model whose harness reports no image input locks
  // both image sources, with the refusal code and the machine that refuses.
  it("locks both image sources for a model that takes no images", async () => {
    const props = await draw({ images: { model: "qwen3-coder-72b", imageInput: false } })

    expect(screen.getByText("takes no image input, as its harness reports")).toBeOnTheScreen()
    expect(screen.getAllByText("Locked for this model.")).toHaveLength(2)
    expect(screen.getAllByText("refused by mac-mini-m4 · attach.image.model_no_input")).toHaveLength(2)
    expect(screen.queryByRole("button", { name: /Photo or screenshot/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Take a photo/ })).toBeNull()
    // A screen reader hears the same facts the row shows.
    expect(screen.getByLabelText("Take a photo: locked for this model, refused by mac-mini-m4 · attach.image.model_no_input")).toBeOnTheScreen()
    await fireEvent.press(screen.getByText("Take a photo"))
    expect(props.onTakePhoto).not.toHaveBeenCalled()
    expect(props.onPickLibrary).not.toHaveBeenCalled()
  })

  // Not knowing is not no: the sources stay open and the line says it is not
  // known. The daemon still refuses a send the model cannot take.
  it("keeps the sources open when the model's image input is not known", async () => {
    await draw({ images: { model: "qwen3-coder-72b", imageInput: undefined } })

    expect(screen.getByText("image input not known")).toBeOnTheScreen()
    expect(screen.queryByText("Locked for this model.")).toBeNull()
    expect(screen.getByRole("button", { name: /Photo or screenshot/ })).toBeOnTheScreen()
  })

  it("shows a refusal where the person is looking", async () => {
    await draw({ problem: "IMG_0002.heic is not a PNG or JPEG. Only those two are sent." })
    expect(screen.getByText("IMG_0002.heic is not a PNG or JPEG. Only those two are sent.")).toBeOnTheScreen()
  })
})
