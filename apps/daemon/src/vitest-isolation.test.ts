import { describe, expect, it } from "vitest"
import { runningInCi } from "../vitest.global-setup.js"

describe("native profile guard CI detection", () => {
  it.each([
    ["true", true],
    ["1", true],
    [undefined, false],
    ["", false],
    ["false", false],
    ["FALSE", false],
    ["0", false],
  ])("treats CI=%s as %s", (flag, expected) => {
    expect(runningInCi(flag === undefined ? {} : { CI: flag })).toBe(expected)
  })
})
