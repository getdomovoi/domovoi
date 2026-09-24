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
    expect(output).toContain("export API_KEY=[REDACTED]")
  })

  it("redacts an assignment split exactly at the name and its value", () => {
    const output = drain(new TerminalOutputRedactor(), ["export API_KEY=", "hunter2\r\n"])
    expect(output).not.toContain("hunter2")
    expect(output).toContain("export API_KEY=[REDACTED]")
  })

  it("redacts an assignment split across three reads", () => {
    const output = drain(new TerminalOutputRedactor(), ["export API_", "KEY=hun", "ter2\r\n"])
    expect(output).not.toContain("hunter2")
    expect(output).toContain("export API_KEY=[REDACTED]")
  })

  it("redacts a value longer than the carry that arrives without its delimiter", () => {
    const value = "a".repeat(400)
    const redactor = new TerminalOutputRedactor()
    const first = redactor.push(`export API_KEY=${value}`)
    const second = redactor.push("\r\nls\r\n")
    const output = `${first}${second}${redactor.flush()}`
    expect(output).not.toContain("aaaa")
    expect(output).toContain("export API_KEY=[REDACTED]")
    expect(output).toContain("ls")
  })

  it("keeps dropping a long value across several reads until it ends", () => {
    const redactor = new TerminalOutputRedactor()
    const parts = [`TOKEN=${"b".repeat(300)}`, "b".repeat(300), "b".repeat(50), " done\r\n"]
    const output = `${parts.map((part) => redactor.push(part)).join("")}${redactor.flush()}`
    expect(output).not.toContain("bbbb")
    expect(output).toContain("TOKEN=[REDACTED]")
    expect(output).toContain(" done")
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

  it("gives back what it was holding when the terminal ends, redacted", () => {
    const redactor = new TerminalOutputRedactor()
    expect(redactor.push("export API_KEY=sk-live-abcdef")).toBe("export ")
    const flushed = redactor.flush()
    expect(flushed).toContain("API_KEY=[REDACTED]")
    expect(flushed).not.toContain("sk-live-abcdef")
    expect(redactor.flush()).toBe("")
  })

  it("loses nothing when a terminal exits mid-line", () => {
    const redactor = new TerminalOutputRedactor()
    const emitted = redactor.push("build failed: TOKEN=")
    expect(`${emitted}${redactor.flush()}`).toContain("build failed:")
  })

  // An idle beat releases what is held so a prompt shows, but the redactor
  // keeps what it knows: a value typed after its name was released is still
  // that name's value.
  describe("release on an idle beat", () => {
    function run(steps: readonly (string | "idle")[]): string {
      const redactor = new TerminalOutputRedactor()
      return `${steps.map((step) => step === "idle" ? redactor.release() : redactor.push(step)).join("")}${redactor.flush()}`
    }

    it("shows the name and hides a value typed after the release", () => {
      for (const [name, value] of [["export API_KEY=", "hunter2"], ["Password: ", "hunter2"], ["curl --token ", "hunter2"], ["-Dpassword=", "hunter2"]] as const) {
        const output = run([name, "idle", `${value}\r\n`, "ls\r\n"])
        expect(output, name).not.toContain("hunter2")
        expect(output, name).toContain(`${name}[REDACTED]`)
        expect(output, name).toContain("\r\nls\r\n")
      }
    })

    it("hides the rest of a partial value released on the beat", () => {
      const output = run(["export API_KEY=sk-li", "idle", "ve-abcdef\r\n"])
      expect(output).not.toContain("sk-li")
      expect(output).not.toContain("abcdef")
      expect(output).toBe("export API_KEY=[REDACTED]\r\n")
    })

    it("keeps a released name as context so a separator and value after it are still caught", () => {
      for (const steps of [["export API_KEY", "idle", "=hunter2\r\n"], ["export API_", "idle", "KEY=hunter2\r\n"], ["export API_", "idle", "KE", "idle", "Y=hunter2 done\r\n"]]) {
        const output = run(steps)
        expect(output, steps.join("|")).not.toContain("hunter2")
        expect(output, steps.join("|")).toBe(steps.at(-1)!.endsWith("done\r\n") ? "export API_KEY=[REDACTED] done\r\n" : "export API_KEY=[REDACTED]\r\n")
      }
    })

    it("shows each character once, and adds nothing to ordinary output", () => {
      expect(run(["me@host:~$ ", "idle", "ls\r\n"])).toBe("me@host:~$ ls\r\n")
      expect(run(["Downloading", "idle", " 50%", "idle", "\r\n"])).toBe("Downloading 50%\r\n")
      // A name with no separator, then ordinary text: nothing is swallowed.
      expect(run(["Enter password", "idle", " below\r\n"])).toBe("Enter password below\r\n")
      expect(run(["passwords", "idle", " are hashed\r\n"])).toBe("passwords are hashed\r\n")
    })

    it("stops treating input as a value at its delimiter, and after flush", () => {
      const redactor = new TerminalOutputRedactor()
      const shown = [redactor.push("TOKEN="), redactor.release(), redactor.push("abc"), redactor.push("def; echo ok\r\n")].join("")
      expect(shown).toBe("TOKEN=[REDACTED]; echo ok\r\n")
      redactor.push("TOKEN=")
      redactor.release()
      redactor.flush()
      expect(redactor.push("visible\r\n")).toBe("visible\r\n")
    })
  })

  it("drops a value that outgrows a line's context, until it ends", () => {
    for (const [prefix, closer] of [["export API_KEY=", " done\r\n"], ["export API_KEY=\"", "\" done\r\n"]] as const) {
      const redactor = new TerminalOutputRedactor()
      const parts = [prefix, ...Array.from({ length: 12 }, () => "q".repeat(1_000)), closer]
      const output = `${parts.map((part) => redactor.push(part)).join("")}${redactor.flush()}`
      expect(output, prefix).not.toContain("qqqq")
      expect(output, prefix).toContain(" done\r\n")
    }
  })

  // Review round 8: a sensitive name at the end of an ordinary identifier is
  // not a name, before or after an idle beat, as main reads it.
  it.each([
    ["total_token=", "5\r\n"],
    ["has_secret=", "false\r\n"],
    ["max_password_length: ", "12\r\n"],
  ])("keeps %j then %j as it is across an idle beat", (name, value) => {
    const redactor = new TerminalOutputRedactor()
    const shown = [redactor.push(name), redactor.release(), redactor.push(value), redactor.flush()].join("")
    expect(shown).toBe(`${name}${value}`)
  })
})

