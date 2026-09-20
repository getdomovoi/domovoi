import { describe, expect, it, jest } from "@jest/globals"
import { fireEvent, render, screen } from "@testing-library/react-native"
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context"

import type { Attachment } from "../attachments"
import { Composer } from "./composer"

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
}

const before: Attachment = { name: "before.png", mimeType: "image/png", width: 800, height: 600, data: "", bytes: 1_400_000 }
const after: Attachment = { name: "after.png", mimeType: "image/png", width: 800, height: 600, data: "", bytes: 900_000 }

async function draw(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const props = {
    draft: "",
    readiness: { can: true as const, hint: undefined },
    sending: false,
    problem: "",
    skillLabel: "defaults",
    attachments: [] as Attachment[],
    attachmentSummary: undefined as string | undefined,
    attachmentsAllowed: true,
    planAvailable: true,
    onChangeDraft: jest.fn<(draft: string) => void>(),
    onOpenPlan: jest.fn<() => void>(),
    onFocusChange: jest.fn<(focused: boolean) => void>(),
    onSend: jest.fn<() => void>(),
    onOpenSkills: jest.fn<() => void>(),
    onOpenAttach: jest.fn<() => void>(),
    onRemoveAttachment: jest.fn<(index: number) => void>(),
    ...overrides,
  }
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <Composer {...props} />
    </SafeAreaProvider>,
  )
  return props
}

describe("Composer attachments", () => {
  it("rests as the compact v2 composer without desktop-only skill chrome", async () => {
    await draw()
    expect(screen.getByPlaceholderText("Message for the next turn")).toBeOnTheScreen()
    expect(screen.queryByText("Skills")).toBeNull()
    expect(screen.getByRole("button", { name: "Open plan" })).toBeOnTheScreen()
  })

  it("expands on focus and reports when tabs must hide", async () => {
    const props = await draw()
    const input = screen.getByLabelText("Reply to this session")
    await fireEvent(input, "focus")
    expect(props.onFocusChange).toHaveBeenCalledWith(true)
    await fireEvent(input, "blur")
    expect(props.onFocusChange).toHaveBeenCalledWith(false)
  })

  it("locks every composer control while watching only", async () => {
    const props = await draw({
      readiness: { can: false, reason: "Watching only. This phone can read the session but cannot change it." },
    })
    expect(screen.getByText("Watching only. This phone can read the session but cannot change it.")).toBeOnTheScreen()
    expect(screen.queryByRole("button", { name: "Open plan" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Attach an image" })).toBeNull()
    await fireEvent.press(screen.getByRole("button", { name: "Send" }))
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it("grows into a card with each queued image removable and the size line under them", async () => {
    const summary = "2.3 MB uploads to mac-mini-m4 when you send, and is not kept on this phone."
    const props = await draw({ attachments: [before, after], attachmentSummary: summary })

    expect(screen.getByText("before.png")).toBeOnTheScreen()
    expect(screen.getByText("after.png")).toBeOnTheScreen()
    expect(screen.getByText(summary)).toBeOnTheScreen()

    await fireEvent.press(screen.getByRole("button", { name: "Remove after.png" }))
    expect(props.onRemoveAttachment).toHaveBeenCalledWith(1)
  })

  it("will not send images without words, and says so", async () => {
    const props = await draw({ attachments: [before], attachmentSummary: "x" })
    expect(screen.getByText("Say what the image is for; a turn needs words.")).toBeOnTheScreen()
    await fireEvent.press(screen.getByRole("button", { name: "Send" }))
    expect(props.onSend).not.toHaveBeenCalled()
  })

  it("opens the attach sheet from the plus, and hides the plus when the daemon cannot take images", async () => {
    const props = await draw()
    await fireEvent.press(screen.getByRole("button", { name: "Attach an image" }))
    expect(props.onOpenAttach).toHaveBeenCalledTimes(1)

    await draw({ attachmentsAllowed: false })
    expect(screen.queryByRole("button", { name: "Attach an image" })).toBeNull()
  })
})
