/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import type { FontFace } from "./tokens.generated"

const require = createRequire(import.meta.url)
const tokens = require("./tokens.generated.js") as {
  fonts: readonly FontFace[]
  fontFamily: Record<string, string>
}
const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const sourceRoot = join(mobileRoot, "src")

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry: Dirent) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : []
  })
}

// Every font utility a screen can write, with the file and line it sits on, so
// a failure names the place to fix rather than the count of places. Import
// lines are skipped because a module path such as ./theme/font-gate is not a
// class.
function fontUtilities(): Array<{ utility: string, at: string }> {
  return sourceFiles(sourceRoot).flatMap((path) =>
    readFileSync(path, "utf8").split("\n").flatMap((line: string, index: number) =>
      line.startsWith("import ") ? [] : [...line.matchAll(/\bfont-([\w-]+)/g)].map((match) => ({
        utility: match[1] as string,
        at: `${path.slice(mobileRoot.length + 1)}:${index + 1}`,
      })),
    ),
  )
}

describe("font registration", () => {
  it("names a registered face for every font utility the app writes", () => {
    const unregistered = fontUtilities().filter(({ utility }) => !(utility in tokens.fontFamily))
    expect(unregistered).toEqual([])
  })

  it("never asks React Native to synthesise a weight", () => {
    const styled = sourceFiles(sourceRoot).filter((path) => /fontWeight|fontFamily\s*:/.test(readFileSync(path, "utf8")))
    expect(styled).toEqual([])
  })

  it("registers exactly the faces the generated utilities point at", () => {
    const registration = readFileSync(join(sourceRoot, "theme", "fonts.ts"), "utf8")
    const imported = [...registration.matchAll(/^import (\w+) from "([^"]+\.ttf)"$/gm)]
      .map((match) => [match[1], match[2]])
    const expected = tokens.fonts.map((face) => [face.name, `${face.package}/${face.file}`])
    expect(imported).toEqual(expected)
    const registered = /export const fontSources[^{]*\{([^}]*)\}/.exec(registration)?.[1] ?? ""
    expect(registered.split(",").map((key) => key.trim()).filter(Boolean)).toEqual(tokens.fonts.map((face) => face.name))
    expect(Object.values(tokens.fontFamily).sort()).toEqual(tokens.fonts.map((face) => face.name).sort())
  })

  it("ships a font file for every registered face", () => {
    const missing = tokens.fonts
      .map((face) => `${face.package}/${face.file}`)
      .filter((file) => !existsSync(join(mobileRoot, "node_modules", file)))
    expect(missing).toEqual([])
  })
})
