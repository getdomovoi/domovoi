import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"

const sourceDirectory = import.meta.dirname

function source(file: string): string {
  return readFileSync(join(sourceDirectory, file), "utf8")
}

function shellGeometry(): Record<string, string> {
  const sizes: Record<string, string> = {}
  for (const [, name, value] of source("styles.css").matchAll(/(--shell-[a-z]+):\s*([^;]+);/gu)) {
    sizes[name!] = value!.trim()
  }
  return sizes
}

it("uses the v2 titlebar and drawer geometry without retired rail or inspector tokens", () => {
  const geometry = shellGeometry()
  expect(geometry["--shell-titlebar"]).toBe("46px")
  expect(geometry["--shell-sidebar"]).toBe("268px")
  expect(geometry).not.toHaveProperty("--shell-rail")
  expect(geometry).not.toHaveProperty("--shell-inspector")
  expect(source("sessions-drawer.tsx")).toContain("w-[268px]")
})

const designRegions: Record<string, string> = {
  Rail: "--shell-rail",
  Sidebar: "--shell-sidebar",
  "Thread lane": "--shell-thread",
  Inspector: "--shell-inspector",
  Titlebar: "--shell-titlebar",
  Header: "--shell-header",
  "Control height": "--shell-control",
}

function designGeometry(): Map<string, string | null> {
  const design = readFileSync(join(sourceDirectory, "..", "..", "..", "DESIGN.md"), "utf8")
  const rows = new Map<string, string | null>()
  let productionColumn: number | undefined
  for (const line of design.split("\n")) {
    const columns = line.split("|").map((column) => column.trim())
    if (columns[1] === "Region") {
      const index = columns.indexOf("Production")
      productionColumn = index === -1 ? undefined : index
      continue
    }
    const token = designRegions[columns[1] ?? ""]
    const cell = productionColumn === undefined ? undefined : columns[productionColumn]
    if (!token || cell === undefined) continue
    rows.set(token, cell === "none" ? null : (/^(\d+px)\b/u.exec(cell)?.[1] ?? cell))
  }
  return rows
}

it("keeps the shell geometry tokens equal to the Production column in DESIGN.md", () => {
  const design = designGeometry()
  const styles = shellGeometry()

  expect([...design.keys()].sort()).toEqual(Object.values(designRegions).sort())
  for (const [token, size] of design) {
    if (size === null) expect(styles).not.toHaveProperty(token)
    else expect(styles[token]).toBe(size)
  }
  for (const token of Object.keys(styles)) expect(design.has(token)).toBe(true)
})

it("does not render the retired workspace rail", () => {
  const shell = source("workspace-shell.tsx")
  expect(shell).not.toContain("WorkspaceRail")
  expect(shell).not.toContain('data-workspace-panel="rail"')
})

it("sizes the default control from the design-system control height", () => {
  const button = source(join("components", "ui", "button.tsx"))
  const sizes = button.slice(button.indexOf("size: {"))
  expect(sizes).toContain("h-[var(--shell-control)]")
})
