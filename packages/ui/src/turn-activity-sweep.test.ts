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

// An infinite loop cannot be shortened into a reduced-motion answer the way an
// entrance can. The skeleton shimmer already stops rather than speeds up, and
// the working bar is the same kind of thing: it stops, and the label beside it
// carries the state alone.
it("stops the sweep when the viewer asks for reduced motion", () => {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)")
  expect(start, "the reduced-motion query is missing").toBeGreaterThanOrEqual(0)
  const open = css.indexOf("{", start)
  let depth = 0
  let body = ""
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1
    else if (css[index] === "}") {
      depth -= 1
      if (depth === 0) {
        body = css.slice(open + 1, index)
        break
      }
    }
  }
  const override = /\.sweep-bar \{([\s\S]*?)\n {2}\}/.exec(body)
  expect(override, "sweep-bar keeps animating under reduced motion").not.toBeNull()
  expect(override![1]).toContain("animation: none")
})
