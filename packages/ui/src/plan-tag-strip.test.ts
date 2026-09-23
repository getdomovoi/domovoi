import { describe, expect, it } from "vitest"

import { stripPlanTags } from "./plan-tag-strip"

describe("stripPlanTags", () => {
  it("leaves a body without plan tags untouched", () => {
    expect(stripPlanTags("Plan ready.\n\n# Composer plan\n")).toBe("Plan ready.\n\n# Composer plan\n")
  })

  it("removes a complete standalone tag pair", () => {
    expect(stripPlanTags("<proposed_plan>\n# Composer plan\n</proposed_plan>")).toBe("# Composer plan")
  })

  it("keeps a blank line between prose and the plan", () => {
    expect(stripPlanTags("Plan ready.\n<proposed_plan>\n# Composer plan\n</proposed_plan>\nRefine it."))
      .toBe("Plan ready.\n\n# Composer plan\n\nRefine it.")
  })

  it("removes an opening tag before the closing tag has streamed", () => {
    expect(stripPlanTags("<proposed_plan>\n## Steps\n\n1. Read")).toBe("## Steps\n\n1. Read")
  })

  it("hides a partially streamed opening tag", () => {
    expect(stripPlanTags("Plan ready.\n<proposed_pl")).toBe("Plan ready.")
  })

  it("hides a partially streamed closing tag", () => {
    expect(stripPlanTags("<proposed_plan>\n1. Read\n</propos")).toBe("1. Read")
  })

  it("keeps text that only looks like the start of a tag", () => {
    expect(stripPlanTags("use <production> here")).toBe("use <production> here")
  })

  it("keeps an inline mention of the tag", () => {
    expect(stripPlanTags("wrap it in <proposed_plan> tags")).toBe("wrap it in <proposed_plan> tags")
  })
})
