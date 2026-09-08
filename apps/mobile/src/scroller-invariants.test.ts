/// <reference types="node" />
import { readdirSync, readFileSync, type Dirent } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = join(mobileRoot, "src")
const wrapper = join(sourceRoot, "components", "page-scroller.tsx")

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry: Dirent) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [path] : []
  })
}

// Every raw ScrollView in the app, with the file and line it sits on, so a
// failure names the place to fix rather than a count of places. The whole
// opening tag is read rather than the one line it starts on, because an
// element split over several lines would otherwise hide its own props.
function rawScrollers(): Array<{ at: string, tag: string }> {
  return sourceFiles(sourceRoot)
    .filter((path) => path !== wrapper)
    .flatMap((path) => {
      const source = readFileSync(path, "utf8")
      return [...source.matchAll(/<ScrollView\b[^>]*>/g)].map((match) => ({
        at: `${path.slice(mobileRoot.length + 1)}:${source.slice(0, match.index).split("\n").length}`,
        tag: match[0],
      }))
    })
}

describe("scroll indicators", () => {
  // The design system hides scrollbars outright on touch, under
  // "@media (hover: none), (pointer: coarse)", because the platform overlays
  // its own. One drawn by the app is a second one.
  it("draws no indicator on any scroller the app writes", () => {
    const showing = rawScrollers().filter(({ tag }) =>
      !/shows(Horizontal|Vertical)ScrollIndicator=\{false\}/.test(tag))
    expect(showing.map((scroller) => scroller.at)).toEqual([])
  })

  // Vertical scrolling belongs to PageScroller, which also measures overflow
  // and reserves the floating bar. A screen that reaches past it loses both.
  it("leaves vertical scrolling to the one wrapper that measures it", () => {
    const vertical = rawScrollers().filter(({ tag }) => !/\bhorizontal\b/.test(tag))
    expect(vertical.map((scroller) => scroller.at)).toEqual([])
  })
})
