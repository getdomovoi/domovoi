import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"

const repositoryRoot = join(import.meta.dirname, "..", "..", "..")

const designRegions: Record<string, string> = {
  Rail: "--shell-rail",
  Sidebar: "--shell-sidebar",
  "Thread lane": "--shell-thread",
  Inspector: "--shell-inspector",
  Titlebar: "--shell-titlebar",
  Header: "--shell-header",
  "Control height": "--shell-control",
}

function designGeometry(): Record<string, string> {
  const design = readFileSync(join(repositoryRoot, "DESIGN.md"), "utf8")
  const sizes: Record<string, string> = {}
  for (const line of design.split("\n")) {
    const columns = line.split("|").map((column) => column.trim())
    const region = columns[1]
    const system = columns[2]
    if (!region || !system || !(region in designRegions)) continue
    const size = /(\d+)px/u.exec(system)?.[1]
    if (size) sizes[designRegions[region]!] = `${size}px`
  }
  return sizes
}

function styleGeometry(): Record<string, string> {
  const styles = readFileSync(join(import.meta.dirname, "styles.css"), "utf8")
  const sizes: Record<string, string> = {}
  for (const [, name, value] of styles.matchAll(/(--shell-[a-z]+):\s*([^;]+);/gu)) {
    sizes[name!] = value!.trim()
  }
  return sizes
}

it("keeps the shell geometry tokens equal to the design system", () => {
  const design = designGeometry()

  expect(Object.keys(design).sort()).toEqual(Object.values(designRegions).sort())
  expect(styleGeometry()).toEqual(design)
})
