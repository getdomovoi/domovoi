import { describe, expect, it } from "vitest"

import { TerminalOutputRedactor } from "./secret-redaction.js"

// Every way a line can reach the redactor: whole, split once at every point,
// and split twice at every pair of points, with and without an idle beat
// between the parts. A secret must never appear in what is shown, and a line
// with no secret must come out exactly as it went in. A new split that leaks
// is caught here, not in review.

type Step = string | "idle"

function run(steps: readonly Step[]): string {
  const redactor = new TerminalOutputRedactor()
  const shown = steps.map((step) => step === "idle" ? redactor.release() : redactor.push(step)).join("")
  return `${shown}${redactor.flush()}`
}

function splits(line: string): Step[][] {
  const ways: Step[][] = [[line], [line, "idle"]]
  for (let first = 1; first < line.length; first += 1) {
    ways.push([line.slice(0, first), line.slice(first)])
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
  { line: "echo ghp_zqxj7wvkmqzqxj done\r\n", value: "ghp_zqxj7wvkmqzqxj" },
]

function fragments(value: string): string[] {
  const words = value.split(" ").filter(Boolean)
  return words.flatMap((word) => Array.from({ length: Math.max(1, word.length - 2) }, (_, index) => word.slice(index, index + 3)))
}

// Lines that name a secret word but carry no secret: shown exactly.
const plain: readonly string[] = [
  "passwords are hashed\r\n",
  "Enter password below\r\n",
  "password\r\nhello world\r\n",
  "Password:\r\nhello world\r\n",
  "token count 5\r\n",
  "me@host:~$ ls -la\r\n",
]

describe("terminal redaction at every split point", () => {
  for (const { line, value } of secrets) {
    it(`never shows the value of ${JSON.stringify(line)}`, () => {
      for (const steps of splits(line)) {
        const output = run(steps)
        for (const part of fragments(value)) expect(output, JSON.stringify(steps)).not.toContain(part)
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
const reviewCases: readonly { name: string, steps: readonly Step[], value: string, plain?: readonly string[] }[] = [
  { name: "an assignment followed by more spaces than a line keeps", steps: ["export API_KEY=", " ".repeat(8_200), "zqxjwvkm\r\n"], value: "zqxjwvkm" },
  { name: "an assignment followed by spaces, then an idle beat", steps: ["export API_KEY=", " ".repeat(8_200), "idle", "zqxjwvkm\r\n"], value: "zqxjwvkm" },
  { name: "an oversized quoted value with an escaped quote", steps: ["export API_KEY=\"", "q".repeat(9_000), "\\\"zqxjwvkm", "\" done\r\n"], value: "zqxjwvkm" },
  { name: "an escaped quote split from its backslash", steps: ["export API_KEY=\"", "q".repeat(9_000), "\\", "\"zqxjwvkm\" done\r\n"], value: "zqxjwvkm" },
  { name: "an oversized unclosed quote, then plain lines", steps: ["export API_KEY=\"", "q".repeat(9_000), "\r\nplain line one\r\nplain line two\r\n"], value: "qqqq", plain: ["plain line one\r\n", "plain line two\r\n"] },
]

describe("terminal redaction on the cases review reported", () => {
  for (const { name, steps, value, plain: shownLines } of reviewCases) {
    it(name, () => {
      const output = run(steps)
      for (const part of fragments(value)) expect(output).not.toContain(part)
      for (const line of shownLines ?? []) expect(output).toContain(line)
    })
  }
})

// Review cases that leak on main as well, before this change. They are held
// open with it.fails until the owner decides whether they belong here or in a
// follow-up: each assertion fails today, and turns this test red when fixed.
const openCases: readonly { name: string, steps: readonly Step[] }[] = [
  { name: "an ANSI sequence between the name and its separator", steps: ["export API_KEY\x1b[0m=zqxjwvkm\r\n"] },
  { name: "a carriage return and cursor move before the value", steps: ["export API_KEY=", "idle", "\r\x1b[8Czqxjwvkm\r\n"] },
  { name: "a bare token longer than a line keeps", steps: ["echo ghp_", "zqxj", "a".repeat(8_300), "wvkm done\r\n"] },
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
