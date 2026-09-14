import { createRequire } from "node:module"

import { expect, it } from "vitest"

// cn carries a role's line height as leading-[..] at runtime, and Tailwind's
// content scan reads source files, not runtime strings. The heights it can
// emit are the finite set in the generated fontSize map, so the config lists
// them; this compiles the real config against an empty content set and asks
// for every one of them, so a token change that adds a new height cannot
// silently produce a class with no rule behind it.
it("compiles a leading utility for every line height a role carries", async () => {
  const require = createRequire(import.meta.url)
  const tailwind = require("tailwindcss")
  const postcss = createRequire(require.resolve("tailwindcss"))("postcss")
  process.env.NATIVEWIND_OS = "ios"
  const config = require("../../tailwind.config.js")
  const { fontSize } = require("./tokens.generated.js") as { fontSize: Record<string, string | [string, string]> }
  const heights = [...new Set(Object.values(fontSize).flatMap((size) => (Array.isArray(size) ? [size[1]] : [])))]
  expect(heights.length).toBeGreaterThan(0)
  const css = await postcss([tailwind({ ...config, content: [{ raw: "", extension: "tsx" }] })])
    .process("@tailwind utilities;", { from: undefined })
  const selectors = new Set<string>()
  css.root.walkRules((rule: { selector: string }) => selectors.add(rule.selector))
  for (const height of heights) {
    expect(selectors.has(`.leading-\\[${height.replace(".", "\\.")}\\]`), `leading-[${height}]`).toBe(true)
  }
})
