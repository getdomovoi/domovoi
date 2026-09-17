import { describe, expect, it, jest } from "@jest/globals"
import { fireEvent, render, screen } from "@testing-library/react-native"

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

describe("AttachSheet", () => {
  it("offers the two image sources with the bound, and names what the other three wait on", async () => {
    const props = await draw()

    expect(screen.getByText("up to 1.5 MB and 2048 px, uploaded to mac-mini-m4 and not stored here")).toBeOnTheScreen()
    expect(screen.getByText("one shot, sent with the turn, same bound")).toBeOnTheScreen()
    for (const waits of [
      "desktop work: a phone holds no worktree to pick from",
      "waits on a read-only terminal path, which a phone does not have yet",
      "not built: an outbound fetch on a phone's word needs its own gate line",
    ]) expect(screen.getByText(waits)).toBeOnTheScreen()
    // The three that wait are stated, not tappable.
    expect(screen.queryByRole("button", { name: /File from the worktree/ })).toBeNull()

    await fireEvent.press(screen.getByRole("button", { name: /Photo or screenshot/ }))
    await fireEvent.press(screen.getByRole("button", { name: /Take a photo/ }))
    expect(props.onPickLibrary).toHaveBeenCalledTimes(1)
    expect(props.onTakePhoto).toHaveBeenCalledTimes(1)
  })

  it("shows a refusal where the person is looking", async () => {
    await draw({ problem: "IMG_0002.heic is not a PNG or JPEG. Only those two are sent." })
    expect(screen.getByText("IMG_0002.heic is not a PNG or JPEG. Only those two are sent.")).toBeOnTheScreen()
  })
})
