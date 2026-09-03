import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { WorkspaceErrorBoundary } from "./error-boundary.js"

afterEach(cleanup)

function ExplodingChild(): never {
  throw new Error("malformed thread entry")
}

describe("WorkspaceErrorBoundary", () => {
  it("shows the failure and a reload action when the workspace tree throws", () => {
    render(
      <WorkspaceErrorBoundary>
        <ExplodingChild />
      </WorkspaceErrorBoundary>,
    )

    const alert = screen.getByRole("alert")
    expect(alert.textContent).toContain("Domovoi could not show this workspace")
    expect(alert.textContent).toContain("malformed thread entry")
    expect(screen.getByRole("button", { name: "Reload" })).toBeDefined()
  })

  it("renders the workspace while nothing throws", () => {
    render(
      <WorkspaceErrorBoundary>
        <p>workspace is fine</p>
      </WorkspaceErrorBoundary>,
    )

    expect(screen.getByText("workspace is fine")).toBeDefined()
    expect(screen.queryByText("Domovoi could not show this workspace")).toBeNull()
  })
})
