import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { expect, it } from "vitest"

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8")

// v2 draws the working bar as a short segment that travels the track, not as a
// fixed segment fading in place. A fade reads as a stalled render; travel reads
// as progress nobody has to estimate.
it("defines the sweep travel the design set uses", () => {
  const frames = /@keyframes dv-sweep \{([\s\S]*?)\n\}/.exec(css)
  expect(frames, "dv-sweep is missing").not.toBeNull()
  expect(frames![1]).toContain("translateX(-110%)")
  expect(frames![1]).toContain("translateX(460%)")
})

it("runs the sweep at the design set speed", () => {
  const utility = /@utility sweep-bar \{([\s\S]*?)\n\}/.exec(css)
  expect(utility, "sweep-bar is missing").not.toBeNull()
  expect(utility![1]).toContain("animation: dv-sweep 1.5s linear infinite")
})
