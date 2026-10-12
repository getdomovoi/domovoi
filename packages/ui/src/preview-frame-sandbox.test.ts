import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

import { expect, it } from "vitest"

// AGENTS.md: preview documents execute only inside sandboxed artifact
// containers. Every preview frame in this package goes through PreviewFrame,
// which fixes the sandbox itself, so a new render path cannot loosen it by
// writing its own iframe. The DOM tests check the rendered attribute; this
// keeps a second iframe from appearing beside PreviewFrame unnoticed.
const sourceRoot = import.meta.dirname

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (!/\.(ts|tsx)$/u.test(entry.name) || /\.test\.(ts|tsx)$/u.test(entry.name)) return []
    return [path]
  })
}

it("renders preview documents through PreviewFrame only", () => {
  const framing = sourceFiles(sourceRoot)
    .filter((path) => /<iframe\b|createElement\(\s*["']iframe["']/u.test(readFileSync(path, "utf8")))
    .map((path) => relative(sourceRoot, path))

  expect(framing).toEqual(["preview-frame.tsx"])
})

it("fixes the frame sandbox to scripts only, with no prop to change it", () => {
  const source = readFileSync(join(sourceRoot, "preview-frame.tsx"), "utf8")
  const frames = source.match(/<iframe\b[\s\S]*?\/>/gu) ?? []

  expect(frames).toHaveLength(1)
  expect(frames[0]).toContain("sandbox=\"allow-scripts\"")
  expect(frames[0]).toContain("referrerPolicy=\"no-referrer\"")
  expect(frames[0]).not.toMatch(/\{\s*\.\.\./u)
  expect(source).not.toContain("allow-same-origin")
})
