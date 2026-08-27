import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { Runtime } from "@getdomovoi/protocol"

import { demoWorkspace } from "@getdomovoi/protocol"

import { AppBar, RuntimeControls } from "./workspace-shell"

const runtime: Runtime = {
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoning: "medium",
  permissionMode: "build",
  auto: false,
}

describe("RuntimeControls", () => {
  it("locks every runtime input while an update is pending", () => {
    const markup = renderToStaticMarkup(
      <RuntimeControls
        runtime={runtime}
        pending
        onChange={vi.fn()}
        onListModels={vi.fn(async () => [])}
      />,
    )

    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(6)
  })
})

describe("AppBar", () => {
  it("does not offer pause-all before the command is implemented", () => {
    const markup = renderToStaticMarkup(
      <AppBar
        snapshot={demoWorkspace}
        connected
        onOpenProject={vi.fn()}
      />,
    )

    expect(markup).toMatch(/<button(?=[^>]*aria-label="Pause all")(?=[^>]*disabled="")/)
  })
})
