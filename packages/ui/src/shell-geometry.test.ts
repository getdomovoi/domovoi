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
