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
  // Issue #608: formatting between a name and its value, and a value a
  // carriage return and cursor move write after the name.
  { line: "export API_KEY\x1b[0m=zqxj7wvkmq\r\n", value: "zqxj7wvkmq" },
  { line: "\x1b[32mexport API_KEY=\x1b[0mzqxj7wvkmq\r\n", value: "zqxj7wvkmq" },
  { line: "API_KEY=\r\x1b[8Czqxj7wvkmq\r\n", value: "zqxj7wvkmq" },
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
  "\x1b[32mpasswords are hashed\x1b[0m\r\n",
  "Downloading 10%\rDownloading 20%\r\n",
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

// Issue #608: cases that leaked on main before this change. Formatting
// between a name and its value, a carriage return or cursor move that redraws
// the line before the value, and a bare token longer than a line keeps or
// split by an idle beat.
const redrawCases: readonly { name: string, steps: readonly Step[] }[] = [
  { name: "an ANSI sequence between the name and its separator", steps: ["export API_KEY\x1b[0m=zqxjwvkm\r\n"] },
  { name: "a bare token longer than a line keeps", steps: ["echo ghp_", "zqxj", "a".repeat(8_300), "wvkm done\r\n"] },
  // The terminal carries 256 characters, so a token past that bound leaked
  // too, well within a line.
  { name: "a bare token longer than the carry", steps: ["echo ghp_", "zqxj", "a".repeat(300), "wvkm done\r\n"] },
  // A bare token has no name, so what an idle beat releases of it is not
  // context for the rest.
  { name: "a bare token split by an idle beat", steps: ["echo g", "idle", "hp_zqxj7wvkmqzqxj done\r\n"] },
  { name: "a bare token split by an idle beat after its prefix", steps: ["echo ghp_", "idle", "zqxj7wvkmqzqxj done\r\n"] },
  { name: "a bare token split by two idle beats", steps: ["echo ghp_", "idle", "zqxj", "idle", "wvkm done\r\n"] },
  // What follows a long token is still read with it: a name glued to its
  // end keeps its value hidden, as on main.
  { name: "a name glued to the end of a long token", steps: ["echo ghp_", "a".repeat(300), "_token=zqxjwvkm done\r\n"] },
  { name: "a cursor move to the value's column, as review reported", steps: ["API_KEY=", "idle", "\r\x1b[8Czqxjwvkm\r\n"] },
  { name: "a prompt redrawn before its answer", steps: ["Password: ", "idle", "\r\x1b[10Czqxjwvkm\r\n"] },
  { name: "formatting inside the value", steps: ["export API_KEY=zqxj\x1b[1mwvkm\x1b[0m\r\n"] },
  // Security review round 1 of #617: a backslash inside single quotes escapes
  // the next character (owner ruling 2026-09-25), so the quote stays open
  // across the beat and the rest of it is hidden.
  { name: "formatting in the name, an escaped single quote, then an idle beat", steps: ["API_KEY\x1b[0m='abc\\'", "idle", "zqxjwvkm rest' done\r\n"] },
  // Found by the leak-shape fuzz: a name cut by one beat, formatting before
  // its separator, and a quoted value after another beat.
  { name: "a name cut by a beat, formatting before its separator, then a quoted value", steps: ["export a", "ccess", "idle", "-token\x1b[2K =", "idle", " 'zqxjwvkmqk' done\n", "idle"] },
  // Security review round 2 of #617: an OSC string between a name cut by a
  // beat and its separator carries an assignment of its own, which main hides.
  { name: "an assignment inside OSC between a cut name and its separator", steps: ["export API_", "idle", "KEY\x1b]0;PASSWORD=zqxjwvkm\x07=abc done\r\n"] },
  // A quote inside OSC does not close a quoted value that outgrew the carry.
  { name: "a quote inside OSC in an oversized quoted value", steps: ["export API_KEY\x1b[0m='", "q".repeat(300), "\x1b]0;'\x07 zqxjwvkm rest' done\r\n"] },
  { name: "a quote inside OSC in an oversized quoted value main reads", steps: ["export API_KEY='", "q".repeat(300), "\x1b]0;'\x07 zqxjwvkm rest' done\r\n"] },
  // Spaces and a semicolon inside OSC do not end a value that starts after it.
  { name: "OSC between a separator and its value, after a beat", steps: ["API_KEY=", "idle", "\x1b]0;a b\x07zqxjwvkm done\r\n"] },
]

describe("terminal redaction across formatting, redraws and long tokens", () => {
  for (const { name, steps } of redrawCases) {
    it(name, () => {
      const output = run(steps)
      expect(output).not.toContain("zqxj")
      expect(output).not.toContain("wvkm")
    })
  }
})

// Security review round 3 of #617: output far longer than the raw text the
// second stage keeps, in one read or many, with the secret anywhere in it,
// right at 65,536 characters included. The second stage keeps a bounded
// amount of raw text however long the output runs.
const screenBound = 16_384
const line = " API_KEY\x1b[0m=zqxj7wvkmq\r\n"
const longCases: readonly { name: string, steps: readonly Step[] }[] = [
  { name: "one read past 65,536 characters", steps: [`${"a".repeat(65_520)}${line}`] },
  { name: "one read of a megabyte", steps: [`${"a ".repeat(500_000)}${line}`] },
  { name: "many reads past 65,536 characters", steps: [...Array.from({ length: 70 }, () => "a".repeat(1_000)), line] },
  { name: "the value across 65,536 characters in one read", steps: [`${"a".repeat(65_536 - " API_KEY\x1b[0m=zq".length)}${line}`] },
  { name: "the value across 65,536 characters over many reads", steps: [...Array.from({ length: 64 }, () => "a".repeat(1_024)), line.slice(0, 18), line.slice(18)] },
  { name: "a long read, an idle beat, then the value", steps: [`${"a".repeat(70_000)} API_KEY\x1b[0m=`, "idle", "zqxj7wvkmq\r\n"] },
  { name: "a long quoted value main drops, then the secret", steps: [`export API_KEY\x1b[0m='${"q".repeat(80_000)}`, " zqxj7wvkmq' done\r\n"] },
]

describe("terminal redaction of long output", () => {
  for (const { name, steps } of longCases) {
    it(name, () => {
      const redactor = new TerminalOutputRedactor()
      let output = ""
      for (const step of steps) output += step === "idle" ? redactor.release() : redactor.push(step)
      output += redactor.flush()
      expect(output).not.toContain("zqxj")
      expect(output).not.toContain("wvkm")
      // The most raw text the second stage kept at once, reads in progress
      // included.
      expect(redactor.retained).toBeLessThanOrEqual(screenBound)
    })
  }
})

// Security review round 4 of #617: a value nested 100,000 deep, in one read
// and over many. Its reader keeps a bounded stack, and past the bound the
// rest of the value is hidden.
const nestingBound = 16_384
const deep = `echo API_KEY\x1b[0m = ${"$(".repeat(100_000)}zqxjwvkm${")".repeat(100_000)} done\r\n`
const deepCases: readonly { name: string, steps: readonly Step[] }[] = [
  { name: "a value nested 100,000 deep in one read", steps: [deep] },
  { name: "a value nested 100,000 deep over many reads", steps: Array.from({ length: Math.ceil(deep.length / 997) }, (_, index) => deep.slice(index * 997, (index + 1) * 997)) },
  { name: "a value nested 100,000 deep with idle beats", steps: Array.from({ length: Math.ceil(deep.length / 20_000) }, (_, index) => [deep.slice(index * 20_000, (index + 1) * 20_000), "idle"]).flat() },
]

describe("terminal redaction of deeply nested values", () => {
  for (const { name, steps } of deepCases) {
    it(name, () => {
      const redactor = new TerminalOutputRedactor()
      let output = ""
      for (const step of steps) output += step === "idle" ? redactor.release() : redactor.push(step)
      output += redactor.flush()
      expect(output).not.toContain("zqxj")
      expect(output).not.toContain("wvkm")
      expect(redactor.nesting).toBeLessThanOrEqual(nestingBound)
      expect(redactor.retained).toBeLessThanOrEqual(screenBound)
    })
  }
})
