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
    WebView: (props: { testID: string, source: { uri: string } }) => <Host testID={props.testID} {...{ source: props.source }} />,
  }
})

type Artifact = WorkspaceSnapshot["artifacts"][number]

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
    onOpenVariant: jest.fn<(artifactId: string) => void>(),
    ...overrides,
  }
  await render(<ArtifactScreen {...props} />)
  return props
}

describe("ArtifactScreen preview", () => {
  it("shows the render from the machine and says it stays there", async () => {
    await draw({ render: { state: "ready", url: "https://mac.ts.net:47831/artifacts/artifact-preview?signature=s" } })

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

  it("offers the other variants of the same render and opens the one tapped", async () => {
    const mine = preview()
    mine.variant = { id: "a", groupId: "g", label: "A", order: 0 }
    const props = await draw({
      artifact: mine,
      render: { state: "ready", url: "https://x/y" },
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
