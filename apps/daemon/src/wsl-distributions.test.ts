import { describe, expect, it } from "vitest"

import { parseWslDistributions } from "./wsl-distributions.js"

function utf16(text: string, { bom = true } = {}): Buffer {
  return Buffer.from(`${bom ? "﻿" : ""}${text}`, "utf16le")
}

const listing = [
  "  NAME            STATE           VERSION",
  "* Ubuntu-24.04    Running         2",
  "  debian          Stopped         2",
  "  Legacy          Running         1",
  "",
].join("\r\n")

describe("parseWslDistributions", () => {
  it("reads the utf-16 listing wsl.exe writes", () => {
    expect(parseWslDistributions(utf16(listing))).toEqual({ kind: "listed", distributions: [
      { name: "Ubuntu-24.04", state: "Running", version: 2, default: true },
      { name: "debian", state: "Stopped", version: 2, default: false },
      { name: "Legacy", state: "Running", version: 1, default: false },
    ] })
  })

  it("reads the same listing without a byte order mark", () => {
    expect(parseWslDistributions(utf16(listing, { bom: false }))).toEqual(parseWslDistributions(utf16(listing)))
  })

  it("reads string output and ignores only blank rows", () => {
    expect(parseWslDistributions(`${listing}\r\n \t\r\n`)).toEqual(parseWslDistributions(utf16(listing)))
  })

  it("keeps a distribution name that contains spaces", () => {
    const named = ["  NAME  STATE  VERSION", "  Ubuntu 24.04 LTS    Running   2"].join("\r\n")
    expect(parseWslDistributions(utf16(named))).toEqual({ kind: "listed", distributions: [
      { name: "Ubuntu 24.04 LTS", state: "Running", version: 2, default: false },
    ] })
  })

  it("keeps a distribution name exactly as it was registered", () => {
    const doubled = ["  NAME  STATE  VERSION", "* Ubuntu  24.04    Running   2"].join("\r\n")
    expect(parseWslDistributions(utf16(doubled))).toEqual({ kind: "listed", distributions: [
      { name: "Ubuntu  24.04", state: "Running", version: 2, default: true },
    ] })
  })

  it("reports nothing when wsl.exe lists no distribution", () => {
    expect(parseWslDistributions(utf16("  NAME  STATE  VERSION\r\n"))).toEqual({ kind: "listed", distributions: [] })
  })

  it.each(["", "not a header", "prefix NAME STATE VERSION", "NAME STATE VERSION suffix"])(
    "reports an unreadable header as corrupt: %j", (header) => {
      expect(parseWslDistributions(utf16(`${header}\r\n  Ubuntu Running 2\r\n`)))
        .toEqual({ kind: "corrupt", line: 1 })
    },
  )

  it.each(["Ubuntu Running broken", "Ubuntu Running", "Ubuntu Unknown 2", "Running 2"])(
    "reports an unreadable row as corrupt: %j", (row) => {
      expect(parseWslDistributions(utf16(`  NAME  STATE  VERSION\r\n  ${row}\r\n`)))
        .toEqual({ kind: "corrupt", line: 2 })
    },
  )

  it("reports a broken listing without returning partial rows or their contents", () => {
    const broken = [
      "  NAME  STATE  VERSION",
      "  Ubuntu-24.04    Running   2",
      "Windows Subsystem for Linux has no installed distributions.",
      "  Trailing",
    ].join("\r\n")
    expect(parseWslDistributions(utf16(broken))).toEqual({ kind: "corrupt", line: 3 })
  })
})
