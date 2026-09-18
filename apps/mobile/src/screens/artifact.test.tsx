import { describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { fireEvent, render, screen } from "@testing-library/react-native"

import { ArtifactScreen, type PreviewRender } from "./artifact"

// The frame is native and has no module under jest. What the screen hands it
// is the claim under test: the address and nothing else.
jest.mock("react-native-webview", () => {
  const { View: Host } = jest.requireActual<typeof import("react-native")>("react-native")
  return {
    // The host view has no `source`; it is carried as an extra prop so the
    // test can read what the frame was handed.
    WebView: (props: { testID: string, source: { uri: string }, onMessage?: (event: { nativeEvent: { data: string } }) => void }) =>
      <Host testID={props.testID} {...{ source: props.source, onMessage: props.onMessage }} />,
  }
})

type Artifact = WorkspaceSnapshot["artifacts"][number]

const channel = "channel-0123456789abcdef"

function selection(artifactId: string) {
  return JSON.stringify({
    type: "domovoi.preview.selection",
    channel,
    artifactId,
    anchor: { cssSelector: "main > div:nth-of-type(3)", textQuote: "retried after 15m", bbox: { x: 12, y: 340, width: 300, height: 56 } },
    label: "div · retried after 15m",
  })
}

function preview(): Artifact {
  const found = structuredClone(demoWorkspace).artifacts.find((artifact) => artifact.type === "preview")
  if (!found) throw new Error("fixture needs a preview artifact")
  return found
}

async function draw(overrides: Partial<Parameters<typeof ArtifactScreen>[0]> = {}) {
  const props = {
    artifact: preview(),
    comments: [],
    render: undefined as PreviewRender | undefined,
    variants: [],
    onBack: jest.fn<() => void>(),
    onRetryRender: jest.fn<() => void>(),
    onOpenVariant: jest.fn<(artifactId: string) => void>(),
    onComment: jest.fn<(anchor: object, body: string) => Promise<void>>(async () => {}),
    ...overrides,
  }
  await render(<ArtifactScreen {...props} />)
  return props
}

describe("ArtifactScreen preview", () => {
  it("shows the render from the machine and says it stays there", async () => {
    await draw({ render: { state: "ready", url: "https://mac.ts.net:47831/artifacts/artifact-preview?signature=s", channel } })

    const frame = screen.getByTestId("preview-render")
    expect(frame.props.source).toEqual({ uri: "https://mac.ts.net:47831/artifacts/artifact-preview?signature=s" })
    expect(screen.getByText(/The render stays on the machine\./)).toBeOnTheScreen()
    expect(screen.queryByText(/signed fetch/)).toBeNull()
  })

  it("says the render is being fetched, and why when it was refused", async () => {
    await draw({ render: { state: "pending" } })
    expect(screen.getByText("Fetching the render from the machine.")).toBeOnTheScreen()

    await draw({ render: { state: "failed", reason: "Pairing was refused" } })
    expect(screen.getByText(/could not be fetched/)).toBeOnTheScreen()
    expect(screen.getByText(/Pairing was refused/)).toBeOnTheScreen()
  })

  // A failed read says what it tried, what is still true, and offers to try
  // again. The artifact and its comments are on the machine; a phone that
  // could not fetch the render has not changed them.
  it("says what is still true when the render failed, and offers to try again", async () => {
    const { onRetryRender } = await draw({ render: { state: "failed", reason: "Pairing was refused" } })
    expect(screen.getByText("The artifact is still on the machine. The comments below are live; only the picture is missing.")).toBeOnTheScreen()
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }))
    expect(onRetryRender).toHaveBeenCalledTimes(1)
  })

  it("offers the other variants of the same render and opens the one tapped", async () => {
    const mine = preview()
    mine.variant = { id: "a", groupId: "g", label: "A", order: 0 }
    const props = await draw({
      artifact: mine,
      render: { state: "ready", url: "https://x/y", channel },
      variants: [
        { id: mine.id, label: "A" },
        { id: "artifact-preview-b", label: "B" },
        { id: "artifact-preview-c", label: "C" },
      ],
    })

    await fireEvent.press(screen.getByRole("button", { name: "Variant B" }))

    expect(props.onOpenVariant).toHaveBeenCalledWith("artifact-preview-b")
    expect(screen.getByRole("button", { name: "Variant A" }).props.accessibilityState).toEqual({ selected: true })
  })

})

describe("ArtifactScreen comment on an element", () => {
  it("anchors a comment to the element the person tapped and sends it as a reference", async () => {
    const props = await draw({ render: { state: "ready", url: "https://x/y", channel } })

    await fireEvent.press(screen.getByRole("button", { name: "Comment" }))
    expect(screen.getByText("Tap the element in the render you want to comment on.")).toBeOnTheScreen()

    await fireEvent(screen.getByTestId("preview-render"), "message", { nativeEvent: { data: selection(props.artifact.id) } })
    expect(screen.getByText("ANCHORED TO")).toBeOnTheScreen()
    expect(screen.getByText("div · retried after 15m")).toBeOnTheScreen()
    expect(screen.getByText(/Sent as a reference to that element/)).toBeOnTheScreen()

    await fireEvent.changeText(screen.getByLabelText("Comment on this element"), "Fifteen minutes is too long.")
    await fireEvent.press(screen.getByRole("button", { name: "Send to the agent" }))

    expect(props.onComment).toHaveBeenCalledWith(
      { cssSelector: "main > div:nth-of-type(3)", textQuote: "retried after 15m", bbox: { x: 12, y: 340, width: 300, height: 56 } },
      "Fifteen minutes is too long.",
    )
    expect(screen.queryByText("ANCHORED TO")).toBeNull()
  })

  it("ignores a selection for another render and will not send an empty comment", async () => {
    const props = await draw({ render: { state: "ready", url: "https://x/y", channel } })

    await fireEvent.press(screen.getByRole("button", { name: "Comment" }))
    await fireEvent(screen.getByTestId("preview-render"), "message", { nativeEvent: { data: selection("artifact-other") } })
    expect(screen.queryByText("ANCHORED TO")).toBeNull()

    await fireEvent(screen.getByTestId("preview-render"), "message", { nativeEvent: { data: selection(props.artifact.id) } })
    await fireEvent.press(screen.getByRole("button", { name: "Send to the agent" }))
    expect(props.onComment).not.toHaveBeenCalled()
  })

  it("offers no comment while the render is not on screen", async () => {
    await draw({ render: { state: "pending" } })
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull()
  })
})
