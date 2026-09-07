import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { demoWorkspace } from "@getdomovoi/protocol"
import { ArtifactDock } from "./workspace-shell"

afterEach(cleanup)
it("names a missing remote preview path without issuing an artifact capability", () => {
  const authorize = vi.fn()
  render(<ArtifactDock snapshot={demoWorkspace} onCollapse={vi.fn()} defaultTab="preview"
    previewRefusal="This remote connection supports RPC and Terminal. Preview frames need a separate verified path."
    rpcUrl="wss://studio.example/rpc" authorizeArtifact={authorize} connected
    terminalControls={{ clientId: "test", create: vi.fn(), claim: vi.fn(), write: vi.fn(), resize: vi.fn(), close: vi.fn(), subscribe: () => () => {} }}
    onReplyToAnnotation={vi.fn()} onSetAnnotationStatus={vi.fn()} onCreateAnnotation={vi.fn()} onLoadSessionHistory={vi.fn()}
    onLoadSessionEvidence={vi.fn()} onRevertSessionFile={vi.fn()} />)
  expect(screen.getByText("Preview frames need a separate verified path.", { exact: false })).toBeTruthy()
  expect(document.querySelector("iframe")).toBeNull()
  expect(authorize).not.toHaveBeenCalled()
})
