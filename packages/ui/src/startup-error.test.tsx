import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { StartupError } from "./startup-error"

describe("StartupError", () => {
  it("renders a visible startup failure", () => {
    const markup = renderToStaticMarkup(<StartupError message="Desktop authentication failed" />)

    expect(markup).toContain("Domovoi could not start")
    expect(markup).toContain("Desktop authentication failed")
  })
})
