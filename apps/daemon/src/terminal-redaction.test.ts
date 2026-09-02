import { describe, expect, it } from "vitest"

import { TerminalOutputRedactor, terminalRedactionCarryCharacters } from "./secret-redaction.js"

function drain(redactor: TerminalOutputRedactor, chunks: readonly string[]): string {
  return `${chunks.map((chunk) => redactor.push(chunk)).join("")}${redactor.flush()}`
}

describe("TerminalOutputRedactor", () => {
  it("redacts an assignment that arrives whole", () => {
    const output = drain(new TerminalOutputRedactor(), ["export API_KEY=sk-live-abcdef\r\n"])
    expect(output).not.toContain("sk-live-abcdef")
    expect(output).toContain("[REDACTED]")
  })

  it("redacts an assignment split across two reads", () => {
    const output = drain(new TerminalOutputRedactor(), ["export API_KEY=sk-live-", "abcdef123456\r\n"])
    expect(output).not.toContain("sk-live-")
    expect(output).not.toContain("abcdef123456")
  })

  it("redacts an assignment split exactly at the name and its value", () => {
    const output = drain(new TerminalOutputRedactor(), ["export API_KEY=", "hunter2\r\n"])
    expect(output).not.toContain("hunter2")
  })

  it("redacts an assignment split across three reads", () => {
    const output = drain(new TerminalOutputRedactor(), ["export API_", "KEY=hun", "ter2\r\n"])
    expect(output).not.toContain("hunter2")
  })

  it("hands back ordinary output without holding it", () => {
    const redactor = new TerminalOutputRedactor()
    expect(redactor.push("me@host:~$ ")).toBe("me@host:~$ ")
    expect(redactor.push("total 48\r\n")).toBe("total 48\r\n")
  })

  it("passes a read far larger than the durable bound through without losing it", () => {
    const chunk = "x".repeat(70_000)
    const redactor = new TerminalOutputRedactor()
    const emitted = redactor.push(chunk)
    expect(chunk.length - emitted.length).toBeLessThanOrEqual(terminalRedactionCarryCharacters)
    expect(`${emitted}${redactor.flush()}`).toBe(chunk)
  })

  it("holds back no more than the carry bound", () => {
    const redactor = new TerminalOutputRedactor()
    const chunk = `${"y".repeat(1_000)} plain output ${"z".repeat(400)} still plain`
    const emitted = redactor.push(chunk)
    expect(chunk.length - emitted.length).toBeLessThanOrEqual(terminalRedactionCarryCharacters)
  })

  it("gives back what it was holding when the terminal ends", () => {
    const redactor = new TerminalOutputRedactor()
    expect(redactor.push("export API_KEY=")).toBe("export ")
    expect(redactor.flush()).toContain("API_KEY=")
    expect(redactor.flush()).toBe("")
  })

  it("loses nothing when a terminal exits mid-line", () => {
    const redactor = new TerminalOutputRedactor()
    const emitted = redactor.push("build failed: TOKEN=")
    expect(`${emitted}${redactor.flush()}`).toContain("build failed:")
  })
})
