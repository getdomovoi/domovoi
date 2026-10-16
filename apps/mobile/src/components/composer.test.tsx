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
    onRemoveAttachments: jest.fn<() => void>(),
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
    expect(screen.getByPlaceholderText("Steer it, or queue a message")).toBeOnTheScreen()
    expect(screen.queryByText("Skills")).toBeNull()
    expect(screen.getByRole("button", { name: "Open plan" })).toBeOnTheScreen()
  })

  it("names the boundary when a running turn will queue the message", async () => {
    await draw({
      readiness: {
        can: true,
        hint: "A turn is running, so this will queue and send at the boundary.",
      },
    })

    expect(screen.getByText("A turn is running, so this will queue and send at the boundary.")).toBeOnTheScreen()
  })

  // F8 (walk 2026-10-15): at rest the composer is a pill that lays its
  // children in one row, so the hint sat beside the input and squeezed its
  // placeholder until it clipped. Frame 12 draws the hint on its own line
  // under the input row; the bar stacks whenever a hint is shown.
  it("puts the running-turn hint on its own line under the input, not beside it", async () => {
    const hint = "A turn is running, so this will queue and send at the boundary."
    await draw({ readiness: { can: true, hint } })

    type Node = { parent: Node | null, type: unknown, props: Record<string, unknown>, children: Node[] }
    const input = screen.getByPlaceholderText("Steer it, or queue a message") as unknown as Node
    const line = screen.getByText(hint) as unknown as Node
    const ancestors = (node: Node) => {
      const chain: Node[] = []
      for (let at = node.parent; at; at = at.parent) chain.push(at)
      return chain
    }
    const inputChain = ancestors(input)
    // The nearest drawn container holding both must stack its children.
    const shared = ancestors(line).find((node) => inputChain.includes(node) && typeof node.type === "string")
    if (!shared) throw new Error("the hint and the input share no container")
    expect(String(shared.props.className ?? "")).not.toMatch(/\bflex-row\b/)
    // And the hint follows the input row, as frame 12 draws it.
    const order = (node: Node) => {
      let at = node
      while (at.parent && at.parent !== shared) at = at.parent
      return shared.children.indexOf(at)
    }
    expect(order(line)).toBeGreaterThan(order(input))
    // The rest stays compact: no skills row until the composer is focused.
    expect(screen.queryByText("Skills")).toBeNull()
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

// Phone v2 frame 14b: images queued for a model whose harness reports no image
// input lock send before it is pressed, and the line names the model. Only a
// model that cannot take them locks it; not knowing says so and sends.
describe("Composer images and the model", () => {
  it("locks send for a model that takes no images, and unlocks it once they are removed", async () => {
    const props = await draw({
      draft: "Before and after",
      attachments: [before, after],
      attachmentSummary: "x",
      images: { model: "qwen3-coder-72b", imageInput: false },
    })

    expect(screen.getByText("2 images cannot go to qwen3-coder-72b. Remove them or pick another model.")).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Send" }).props.accessibilityState).toMatchObject({ disabled: true })
    await fireEvent.press(screen.getByRole("button", { name: "Send" }))
    expect(props.onSend).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByRole("button", { name: "Remove 2 images" }))
    expect(props.onRemoveAttachments).toHaveBeenCalledTimes(1)

    await draw({ draft: "Before and after", images: { model: "qwen3-coder-72b", imageInput: false } })
    expect(screen.queryByText(/cannot go to/)).toBeNull()
    expect(screen.getByRole("button", { name: "Send" }).props.accessibilityState).toMatchObject({ disabled: false })
  })

  it("names one image in the singular", async () => {
    await draw({ draft: "This one", attachments: [before], attachmentSummary: "x", images: { model: "qwen3-coder-72b", imageInput: false } })
    expect(screen.getByText("1 image cannot go to qwen3-coder-72b. Remove it or pick another model.")).toBeOnTheScreen()
    expect(screen.getByRole("button", { name: "Remove 1 image" })).toBeOnTheScreen()
  })

  it("sends images to a model that takes them", async () => {
    const props = await draw({
      draft: "Before and after",
      attachments: [before, after],
      attachmentSummary: "x",
      images: { model: "claude-sonnet-4.6", imageInput: true },
    })

    expect(screen.queryByText(/cannot go to/)).toBeNull()
    expect(screen.queryByText(/does not know whether/)).toBeNull()
    await fireEvent.press(screen.getByRole("button", { name: "Send" }))
    expect(props.onSend).toHaveBeenCalledTimes(1)
  })

  it("says it does not know, and sends, when the model's image input is not known", async () => {
    const props = await draw({
      draft: "Before and after",
      attachments: [before],
      attachmentSummary: "x",
      images: { model: "qwen3-coder-72b", imageInput: undefined },
    })

    expect(screen.getByText("Domovoi does not know whether qwen3-coder-72b takes image input. If it does not, the machine refuses the send and nothing is sent.")).toBeOnTheScreen()
    expect(screen.queryByText(/cannot go to/)).toBeNull()
    await fireEvent.press(screen.getByRole("button", { name: "Send" }))
    expect(props.onSend).toHaveBeenCalledTimes(1)
  })
})
