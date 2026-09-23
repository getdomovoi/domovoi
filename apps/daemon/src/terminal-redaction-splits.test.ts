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
