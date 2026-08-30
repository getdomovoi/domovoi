import { describe, expect, it } from "vitest"

import { maximumPrintableArtifactBytes, safeArtifactFilename, sanitizePrintableArtifact } from "./print-artifact.js"

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

  it("bounds source and tree work", () => {
    expect(() => sanitizePrintableArtifact("x".repeat(maximumPrintableArtifactBytes + 1), "Plan")).toThrow("size limit")
    expect(() => sanitizePrintableArtifact(`<div>${"<div>".repeat(80)}x${"</div>".repeat(80)}</div>`, "Plan")).toThrow("depth limit")
  })
})
