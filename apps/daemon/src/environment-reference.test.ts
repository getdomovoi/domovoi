import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"

const sourceDirectory = import.meta.dirname
const packageDirectory = join(sourceDirectory, "..")

const proofInputs = new Set(["DOMOVOI_WSL_EXPECTED_MOUNT_ROOT", "DOMOVOI_WSL_NATIVE_BUDGET_MS", "DOMOVOI_WSL_NATIVE_TRANSPORT"])

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (!entry.name.endsWith(".ts") || entry.name.includes(".test.") || entry.name.startsWith("test-")) return []
    return [path]
  })
}

function variablesIn(text: string): Set<string> {
  return new Set(text.match(/DOMOVOI_[A-Z0-9_]+/gu) ?? [])
}

function variablesTheDaemonReads(): string[] {
  const read = new Set<string>()
  for (const file of sourceFiles(sourceDirectory)) {
    for (const name of variablesIn(readFileSync(file, "utf8"))) read.add(name)
  }
  return [...read].filter((name) => !proofInputs.has(name)).sort()
}

function helpText(): string {
  const index = readFileSync(join(sourceDirectory, "index.ts"), "utf8")
  const help = /const help = `([\s\S]*?)`/u.exec(index)?.[1]
  if (help === undefined) throw new Error("index.ts no longer defines the help text as `const help`")
  return help.slice(help.indexOf("Environment:"))
}

it("names every variable the daemon reads in --help", () => {
  const help = variablesIn(helpText())
  expect(variablesTheDaemonReads().filter((name) => !help.has(name))).toEqual([])
})

it("names every variable the daemon reads in the package README", () => {
  const readme = variablesIn(readFileSync(join(packageDirectory, "README.md"), "utf8"))
  expect(variablesTheDaemonReads().filter((name) => !readme.has(name))).toEqual([])
})
