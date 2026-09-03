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

function panelDefault(id: string): string | undefined {
  const shell = readFileSync(join(import.meta.dirname, "workspace-shell.tsx"), "utf8")
  return new RegExp(`<ResizablePanel id="${id}"[^>]*?defaultSize=\\{(\\d+)\\}`, "u").exec(shell)?.[1]
}

it("opens the sidebar and inspector at their design-system widths", () => {
  const design = designGeometry()

  expect(`${panelDefault("sessions")}px`).toBe(design["--shell-sidebar"])
  expect(`${panelDefault("dock")}px`).toBe(design["--shell-inspector"])
})

it("keeps the shell geometry tokens equal to the design system", () => {
  const design = designGeometry()

  expect(Object.keys(design).sort()).toEqual(Object.values(designRegions).sort())
  expect(styleGeometry()).toEqual(design)
})
