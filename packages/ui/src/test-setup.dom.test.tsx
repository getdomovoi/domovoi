import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

// Vitest runs without globals here, so testing-library cannot unmount on its
// own. These two run in order: the second fails if the first one's tree is
// still in the document, which is what a suite querying the whole document
// would silently assert against.
describe("dom test setup", () => {
  it("mounts a tree", () => {
    render(<p>first test's tree</p>)
    expect(screen.getByText("first test's tree")).toBeTruthy()
  })

  it("starts the next test from an empty document", () => {
    expect(screen.queryByText("first test's tree")).toBeNull()
    expect(document.body.children).toHaveLength(0)
  })
})
