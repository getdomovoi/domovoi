import { describe, expect, it } from "vitest"

import { TerminalOutputRedactor } from "./secret-redaction.js"

// Every way a line can reach the redactor across idle beats: whole, split once
// at every point with a beat between the parts, and split twice at every pair
// of points with a beat at each. No letter or digit of a secret may show, as
// the prefixed fuzz of #539 counts it: more often in what is shown than in the
// text around the value. A line with no secret must come out exactly as it
// went in. Ruled
// 2026-09-23 (B): the fix is for values typed after an idle beat released
// their name, so splits with no beat between them read as main reads them.

type Step = string | "idle"

function run(steps: readonly Step[]): string {
  const redactor = new TerminalOutputRedactor()
  const shown = steps.map((step) => step === "idle" ? redactor.release() : redactor.push(step)).join("")
  return `${shown}${redactor.flush()}`
}

function splits(line: string): Step[][] {
  const ways: Step[][] = [[line], [line, "idle"]]
  for (let first = 1; first < line.length; first += 1) {
    ways.push([line.slice(0, first), "idle", line.slice(first)])
    for (let second = first + 1; second < line.length; second += 1) {
      ways.push([line.slice(0, first), "idle", line.slice(first, second), "idle", line.slice(second)])
    }
  }
  return ways
}

// Values use letters that appear nowhere else in these lines, so any three
// consecutive characters of a value showing up means part of it leaked.
const secrets: readonly { line: string, value: string }[] = [
  { line: "export API_KEY=zqxj7wvkmq\r\n", value: "zqxj7wvkmq" },
  { line: "export API_KEY=\"zqxj wvkm\"\r\n", value: "zqxj wvkm" },
  { line: "export API_KEY='zqxj wvkm' && ls\r\n", value: "zqxj wvkm" },
  { line: "Password:  zqxj7wvkmq\r\n", value: "zqxj7wvkmq" },
  { line: "curl --token zqxj7wvkmq -s\r\n", value: "zqxj7wvkmq" },
  { line: "curl --token=zqxj7wvkmq\r\n", value: "zqxj7wvkmq" },
  { line: "java -Dpassword=zqxj7wvkmq -jar app.jar\r\n", value: "zqxj7wvkmq" },
  { line: "{\"client_secret\": \"zqxj wvkm\"}\r\n", value: "zqxj wvkm" },
  { line: "$env:GITHUB_TOKEN=\"zqxj7wvkmq\"\r\n", value: "zqxj7wvkmq" },
]

function fragments(value: string): string[] {
  const words = value.split(" ").filter(Boolean)
  return words.flatMap((word) => Array.from({ length: Math.max(1, word.length - 2) }, (_, index) => word.slice(index, index + 3)))
}

function occurrences(text: string, piece: string): number {
  return text.split(piece).length - 1
}

// A letter or digit of the value that shows more often than the text around
// the value holds it, once the replacement marker is taken out.
function exposed(text: string, value: string, output: string): string | undefined {
  const shown = output.replaceAll("[REDACTED]", "\u0000")
  return [...new Set(value.match(/[\p{L}\p{N}]/gu) ?? [])]
    .find((piece) => occurrences(shown, piece) > occurrences(text, piece) - occurrences(value, piece))
}

// Lines that name a secret word but carry no secret: shown exactly. A name and
// separator at the end of a line are not here: main reads the next line as
// their value (`"password":` then a newline and `"value"`), and so does this.
const plain: readonly string[] = [
  "passwords are hashed\r\n",
  "Enter password below\r\n",
  "password\r\nhello world\r\n",
  "token count 5\r\n",
  "me@host:~$ ls -la\r\n",
]

describe("terminal redaction at every split point", () => {
  for (const { line, value } of secrets) {
    it(`never shows the value of ${JSON.stringify(line)}`, () => {
      for (const steps of splits(line)) {
        const output = run(steps)
        for (const part of fragments(value)) expect(output, JSON.stringify(steps)).not.toContain(part)
        expect(exposed(line, value, output), JSON.stringify(steps)).toBeUndefined()
        expect(output, JSON.stringify(steps)).toContain("[REDACTED]")
      }
    })
  }

  for (const line of plain) {
    it(`shows ${JSON.stringify(line)} exactly`, () => {
      for (const steps of splits(line)) expect(run(steps), JSON.stringify(steps)).toBe(line)
    })
  }
})

// Cases from review, run as they were reported. Each is a list of reads with
// idle beats between some of them.
const reviewCases: readonly { name: string, steps: readonly Step[], value: string, plain?: readonly string[], hidden?: readonly string[] }[] = [
  { name: "an assignment followed by more spaces than a line keeps", steps: ["export API_KEY=", " ".repeat(8_200), "zqxjwvkm\r\n"], value: "zqxjwvkm" },
  { name: "an assignment followed by spaces, then an idle beat", steps: ["export API_KEY=", " ".repeat(8_200), "idle", "zqxjwvkm\r\n"], value: "zqxjwvkm" },
  { name: "an oversized quoted value with an escaped quote", steps: ["export API_KEY=\"", "q".repeat(9_000), "\\\"zqxjwvkm", "\" done\r\n"], value: "zqxjwvkm" },
  { name: "an escaped quote split from its backslash", steps: ["export API_KEY=\"", "q".repeat(9_000), "\\", "\"zqxjwvkm\" done\r\n"], value: "zqxjwvkm" },
  // Ruled in #539: a quote that never closes holds the drop open across line
  // breaks until a quote arrives, so the lines after it are hidden too.
  { name: "an oversized unclosed quote, then plain lines", steps: ["export API_KEY=\"", "q".repeat(9_000), "\r\nplain line one\r\nplain line two\r\n"], value: "qqqq", hidden: ["plain line one", "plain line two"] },
  // Round 3: each hidden on main, shown by the line-context stage alone.
  { name: "a JSON name and separator, then its value on the next line", steps: ["{\"password\":\n\"zqxjwvkm\"}\n"], value: "zqxjwvkm" },
  { name: "a closed oversized quote, then the rest of the word", steps: ["API_KEY=\"", "q".repeat(9_000), "\"zqxjwvkm\r\n"], value: "zqxjwvkm" },
  { name: "a property value with an escaped quote, split", steps: ["-", "Dpassword", "=\"aaaa\\\"zqxjwvkm\" done\r\n"], value: "zqxjwvkm" },
  { name: "a property separator, a long run of spaces, then the value", steps: ["-Dpassword=", " ".repeat(8_300), "zqxjwvkm\r\n"], value: "zqxjwvkm" },
  // Held open with it.fails before #539's round 7: an idle beat after a name
  // and its separator now starts a drop of the value that follows.
  { name: "a carriage return and cursor move before the value", steps: ["export API_KEY=", "idle", "\r\x1b[8Czqxjwvkm\r\n"], value: "zqxjwvkm" },
]

describe("terminal redaction on the cases review reported", () => {
  for (const { name, steps, value, plain: shownLines, hidden } of reviewCases) {
    it(name, () => {
      const output = run(steps)
      for (const part of fragments(value)) expect(output).not.toContain(part)
      expect(exposed(steps.filter((step) => step !== "idle").join(""), value, output)).toBeUndefined()
      for (const line of shownLines ?? []) expect(output).toContain(line)
      for (const line of hidden ?? []) expect(output).not.toContain(line)
    })
  }
})

// Review cases that leak on main as well, before this change. They are held
// open with it.fails until the owner decides whether they belong here or in a
// follow-up: each assertion fails today, and turns this test red when fixed.
const openCases: readonly { name: string, steps: readonly Step[] }[] = [
  { name: "an ANSI sequence between the name and its separator", steps: ["export API_KEY\x1b[0m=zqxjwvkm\r\n"] },
  { name: "a bare token longer than a line keeps", steps: ["echo ghp_", "zqxj", "a".repeat(8_300), "wvkm done\r\n"] },
  // A bare token has no name, so what an idle beat releases of it is not
  // context for the rest.
  { name: "a bare token split by an idle beat", steps: ["echo g", "idle", "hp_zqxj7wvkmqzqxj done\r\n"] },
]

describe("terminal redaction cases still open, pre-existing on main", () => {
  for (const { name, steps } of openCases) {
    it.fails(name, () => {
      const output = run(steps)
      expect(output).not.toContain("zqxj")
      expect(output).not.toContain("wvkm")
    })
  }
})
