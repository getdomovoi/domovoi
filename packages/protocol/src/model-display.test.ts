import { describe, expect, it } from "vitest"

import { modelDisplayName } from "./model-display.js"

// The short form is a display name derived from the id, never a second name
// written by hand: drop every token the harness name already says, then space
// the rest. The id stays the identifier wherever it is the only copy.
describe("modelDisplayName", () => {
  it("drops the tokens the harness already says", () => {
    expect(modelDisplayName("claude-sonnet-4.6", "claude-code")).toBe("sonnet 4.6")
    expect(modelDisplayName("gpt-5.3-codex", "codex")).toBe("gpt 5.3")
  })

  it("keeps a model that shares nothing with its harness", () => {
    expect(modelDisplayName("kimi-k3", "opencode")).toBe("kimi k3")
  })

  it("matches tokens whole and case-insensitively, never as substrings", () => {
    expect(modelDisplayName("Claude-Opus-5", "claude-code")).toBe("Opus 5")
    expect(modelDisplayName("codexlike-1", "codex")).toBe("codexlike 1")
  })

  it("falls back to the id when every token belongs to the harness", () => {
    expect(modelDisplayName("codex", "codex")).toBe("codex")
  })

  it("leaves an id with no hyphens alone", () => {
    expect(modelDisplayName("default", "codex")).toBe("default")
  })
})
