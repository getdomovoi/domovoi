import { describe, expect, it } from "vitest"

import {
  maximumPrintableArtifactBytes,
  maximumPrintableArtifactNodes,
  PrintableArtifactError,
  safeArtifactFilename,
  sanitizePrintableArtifact,
} from "./print-artifact.js"

describe("sanitizePrintableArtifact", () => {
  it("preserves semantics and print styles while removing active and remote content", () => {
    const output = sanitizePrintableArtifact(`<!doctype html><html><head>
      <base href="https://attacker.example"><meta http-equiv="refresh" content="0;url=https://attacker.example">
      <style>@import url(https://attacker/x.css); h1 { color: red } @media print { p { break-inside: avoid } }</style>
      <script>alert(document.cookie)</script></head><body onload="steal()">
      <h1>Migration plan</h1><form action="https://attacker"><p>Keep this text</p><input autofocus></form>
      <a href="javascript:alert(1)" onclick="steal()">bad</a><a href="https://example.com">docs</a>
      <img src="https://attacker/track.png"><iframe src="https://attacker"></iframe><object data="x"></object>
      <div style="background:url(https://attacker/x); color: blue">Summary</div></body></html>`, "Migration / plan")
    expect(output).toContain("Migration plan")
    expect(output).toContain("Keep this text")
    expect(output).toContain("@media print")
    expect(output).toContain("default-src 'none'")
    expect(output).toContain("External resources and active content were removed")
    expect(output).toContain('href="https://example.com"')
    expect(output).toContain('rel="noopener noreferrer"')
    expect(output.match(/<!doctype html>/gi)).toHaveLength(1)
    expect(output).toContain("<title>Migration / plan</title>")
    for (const unsafe of ["<script", "<iframe", "<object", "<form", "<input", "onload=", "onclick=", "javascript:", "attacker.example", "@import", "url("]) {
      expect(output.toLowerCase(), unsafe).not.toContain(unsafe)
    }
  })

  it("creates bounded ASCII download names", () => {
    expect(safeArtifactFilename('../../Migration: plan? <script>')).toBe("Migration-plan-script.html")
  })

  it("removes normalized foreign and SMIL elements while retaining inert SVG", () => {
    const output = sanitizePrintableArtifact(`<svg viewBox="0 0 10 10">
      <path d="M0 0L10 10"></path>
      <foreignObject><p>active foreign content</p></foreignObject>
      <animate attributeName="x"></animate><set attributeName="x"></set>
      <animateTransform attributeName="transform"></animateTransform>
      <animateMotion path="M0 0L10 10"></animateMotion>
    </svg>`, "Diagram")

    expect(output).toContain("<svg")
    expect(output).toContain("<path")
    for (const unsafe of ["foreignobject", "active foreign content", "<animate", "<set", "animatetransform", "animatemotion"]) {
      expect(output.toLowerCase(), unsafe).not.toContain(unsafe)
    }
  })

  it("inserts derived metadata as nodes despite hostile tag substrings", () => {
    const output = sanitizePrintableArtifact(
      '<html data-marker="<head>"><head data-marker="<body>"></head><body><main>Plan</main></body></html>',
      "Hostile markers",
    )

    expect(output).toContain('data-marker="<head>"')
    expect(output).toContain('<head data-marker="<body>"><meta charset="utf-8">')
    expect(output).toContain('<body><aside class="domovoi-safe-note"')
    expect(output).not.toContain('data-marker="<head><meta')
    expect(output).not.toContain('data-marker="<body><aside')
  })

  it("bounds source and tree work", () => {
    const cases = [
      ["source-size", "x".repeat(maximumPrintableArtifactBytes + 1)],
      ["tree-depth", `<div>${"<div>".repeat(80)}x${"</div>".repeat(80)}</div>`],
      ["tree-nodes", `<main>${"<i></i>".repeat(maximumPrintableArtifactNodes + 1)}</main>`],
      ["output-size", `<main>${"&".repeat(1_000_000)}</main>`],
    ] as const
    for (const [code, content] of cases) {
      try {
        sanitizePrintableArtifact(content, "Plan")
        throw new Error(`Expected ${code}`)
      } catch (error) {
        expect(error).toBeInstanceOf(PrintableArtifactError)
        expect(error).toMatchObject({ code, kind: "limit" })
      }
    }
  })
})
