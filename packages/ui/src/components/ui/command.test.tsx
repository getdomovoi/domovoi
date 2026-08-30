import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { Command, CommandInput } from "./command"

describe("CommandInput", () => {
  it("identifies itself as the InputGroup focus control", () => {
    const markup = renderToStaticMarkup(
      <Command>
        <CommandInput aria-label="Search commands" />
      </Command>,
    )

    expect(markup).toContain('data-slot="input-group-control"')
  })
})
