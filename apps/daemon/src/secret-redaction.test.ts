import { appendFileSync } from "node:fs"

import { demoWorkspace } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import {
  DurableOutputRedactor,
  maximumDurableCommandLength,
  maximumDurableTextLength,
  maximumStreamingOutputBufferLength,
  redactDurableCommand,
  redactDurableOutput,
  redactDurableText,
  TerminalOutputRedactor,
} from "./secret-redaction.js"
import { redactWorkspaceCopies } from "./workspace-redaction.js"

// Flag and property values with escapes inside their quotes: an escaped quote
// of either kind, an escaped backslash before an escaped quote, an escaped
// backslash alone, and an escaped backslash right before the closing quote,
// which still closes the value. Each must be hidden whole and what follows it
// kept.
const escapedFlagValues = ["\"", "'"].flatMap((quote) => {
  const other = quote === "\"" ? "'" : "\""
  const values = [
    `zqxj\\${quote}mkqz`,
    `zqxj\\${other}mkqz`,
    `zqxj\\\\\\${quote}mkqz`,
    "zqxj\\\\mkqz",
    "zqxjmkqz\\\\",
  ]
  const flags = ["--token ", "--token=", "--x-token ", "--db_password=", "-db-password ", "/token:", "-Dpassword=", "-Dx.password="]
  return flags.flatMap((flag) => values.map((value) => ({
    text: `run ${flag}${quote}${value}${quote} -s`,
    expected: `run ${flag}${quote}[REDACTED]${quote} -s`,
  })))
})

const secrets = [
  "bearer-secret-123",
  "url-password-456",
  "sk-proj-posix-secret",
  "flag-token-789",
  "inline-password-012",
  "ghp_PowerShellSecret",
  "client-secret-cmd",
  "json-api-secret",
  "yaml-password-secret",
  "xoxb-known-token-secret",
  "basic64value",
  "cmd secret with spaces",
  "jvm-password-secret",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signatureSecret",
]

const adversarial = [
  'curl -H "Authorization: Bearer bearer-secret-123" https://example.test',
  "git clone https://alice:url-password-456@example.test/private.git",
  "OPENAI_API_KEY='sk-proj-posix-secret' pnpm test --token flag-token-789 --password=inline-password-012",
  '$env:GITHUB_TOKEN="ghp_PowerShellSecret"; tool --client-secret value',
  "set AZURE_CLIENT_SECRET=client-secret-cmd\r\ntool.exe /password:cmd-password",
  '{"apiKey":"json-api-secret","safe":"visible"}\r\npassword: yaml-password-secret',
  "provider returned xoxb-known-token-secret",
  "Authorization: Basic basic64value",
  'set "PASSWORD=cmd secret with spaces"',
  "java -Dpassword=jvm-password-secret -jar app.jar",
  "unlabeled eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signatureSecret",
].join("\n")

describe("durable secret redaction", () => {
  it("redacts cross-platform command, header, URL, flag, and structured secrets", () => {
    const result = redactDurableText(adversarial)

    expect(result.redacted).toBe(true)
    expect(result.value).toContain("Authorization: [REDACTED]")
    expect(result.value).toContain("https://[REDACTED]@example.test/private.git")
    expect(result.value).toContain("OPENAI_API_KEY='[REDACTED]'")
    expect(result.value).toContain("--token [REDACTED]")
    expect(result.value).toContain("--password=[REDACTED]")
    expect(result.value).toContain('$env:GITHUB_TOKEN="[REDACTED]"')
    expect(result.value).toContain("set AZURE_CLIENT_SECRET=[REDACTED]\r\n")
    expect(result.value).toContain('"apiKey":"[REDACTED]"')
    expect(result.value).toContain("password: [REDACTED]")
    expect(result.value).toContain("Authorization: [REDACTED]")
    expect(result.value).toContain('set "PASSWORD=[REDACTED]"')
    expect(result.value).toContain("-Dpassword=[REDACTED]")
    for (const secret of secrets) expect(result.value).not.toContain(secret)
    expect(result.value).not.toContain("cmd-password")
    expect(result.value).not.toContain("value\n")
  })

  it("preserves safe command structure and avoids secret-word false positives", () => {
    const safe = "TOKEN_BUDGET=4096 pnpm test --password-policy strict secret-santa --token"
    expect(redactDurableCommand(safe)).toEqual({
      value: safe,
      redacted: false,
      truncated: false,
    })
  })

  it.each([
    "DOMOVOI_AUTH_TOKEN",
    "NPM_TOKEN",
    "HF_TOKEN",
    "DATABASE_PASSWORD",
    "POSTGRES_PASSWORD",
    "CLOUDFLARE_API_TOKEN",
    "DJANGO_SECRET_KEY",
    "STRIPE_SECRET_KEY",
    "SECRET_KEY",
  ])("redacts a value assigned to the prefixed name %s", (name) => {
    const value = "fake-value-4f2a9c"
    for (const text of [
      `${name}=${value}`,
      `export ${name}="${value}"`,
      `$env:${name}='${value}'`,
      `set "${name}=${value}"`,
      `{"${name.toLowerCase()}": "${value}"}`,
    ]) {
      expect(redactDurableOutput(text).value, text).not.toContain(value)
      expect(redactDurableCommand(text), text).toMatchObject({ redacted: true })
    }
  })

  it("redacts prefixed secret flags and system properties", () => {
    for (const text of [
      "deploy --npm-token fake-value-4f2a9c",
      "deploy --db_password=fake-value-4f2a9c",
      "java -Ddb.password=fake-value-4f2a9c -jar app.jar",
    ]) {
      expect(redactDurableCommand(text).value, text).not.toContain("fake-value-4f2a9c")
    }
  })

  it.each([
    "//registry.npmjs.org/:_authToken=fake-value-4f2a9c",
    "npm_config__authToken=fake-value-4f2a9c",
  ])("redacts an npm auth token written as %s", (text) => {
    expect(redactDurableOutput(text).value).not.toContain("fake-value-4f2a9c")
    expect(redactDurableCommand(text)).toMatchObject({ redacted: true })
  })

  it.each([
    ["x--password fake-value-4f2a9c", "x--password [REDACTED]"],
    ["x-Dpassword=fake-value-4f2a9c", "x-Dpassword=[REDACTED]"],
  ])("still redacts a flag or property glued to a word, as %s", (text, expected) => {
    expect(redactDurableCommand(text)).toMatchObject({ value: expected, redacted: true })
  })

  it("leaves names that only start with a secret word alone", () => {
    for (const safe of [
      "TOKENIZERS_PARALLELISM=false",
      "MAX_TOKENS=100",
      "PASSWORDLESS=true pnpm test",
      "psql --no-password mydb",
      "mysql --skip-password mydb",
      "pg_dump --without-password mydb",
      "tool --db-no-password mydb",
      "tool --db_skip.password mydb",
      "psql --no-auth-token mydb",
      "tool --skip-client-secret mydb",
      "tool --without-api-key mydb",
      "tool --db-no-auth-token mydb",
    ]) {
      expect(redactDurableCommand(safe), safe).toEqual({ value: safe, redacted: false, truncated: false })
    }
  })

  it.each([
    ["dashes", "-"],
    ["underscores", "_"],
    ["dots", "."],
    ["mixed separators", "-_."],
    ["repeated flag starts", "--a"],
    ["repeated property starts", "-D"],
    ["repeated property names", "-Da"],
    ["flags glued to words", "a--"],
    ["properties glued to words", "a-D"],
    ["counting-word name segments", "total_"],
  ])("scans a 50,000 character run of %s within 200 ms", (_shape, unit) => {
    const text = unit.repeat(Math.ceil(50_000 / unit.length)).slice(0, 50_000)
    let started = performance.now()
    expect(redactDurableOutput(text).value).toBe(text)
    expect(performance.now() - started).toBeLessThan(200)

    started = performance.now()
    const redactor = new TerminalOutputRedactor()
    expect(`${redactor.push(text)}${redactor.flush()}`).toBe(text)
    expect(performance.now() - started).toBeLessThan(200)
  })

  // Ruled 2026-09-24 (option B): after a prefixed sensitive name, the value
  // shows only when the word before the name counts or switches and the value
  // is a plain number or true/false. Every other value stays hidden.
  // The prefix is joined with each form's own separator; the sensitive name
  // keeps its spelling (api_key, access_token).
  const plainValueForms = (prefix: string, suffix: string, value: string) => {
    const name = `${prefix}_${suffix}`
    return [
      `${name}=${value}`,
      `export ${name}="${value}"`,
      `$env:${name}='${value}'`,
      `set "${name}=${value}"`,
      `{"${name}": ${value}}`,
      `{"${name}": "${value}"}`,
      `tool --${prefix.replaceAll("_", "-")}-${suffix} ${value}`,
      `tool --${prefix.replaceAll("_", "-")}-${suffix}=${value}`,
      `java -D${prefix.replaceAll("_", ".")}.${suffix}=${value} -jar app.jar`,
    ]
  }
  const countingWords = ["total", "has", "max", "min", "count", "is", "enable"]
  const sensitiveSuffixes = ["token", "secret", "password", "api_key", "secret_key", "access_token"]

  it.each([
    ["total_token=5"],
    ["has_secret=false"],
  ])("shows %s", (text) => {
    expect(redactDurableCommand(text)).toEqual({ value: text, redacted: false, truncated: false })
    expect(redactDurableOutput(text).value).toBe(text)
  })

  it.each([
    ["DB_PASSWORD=123456", "123456"],
    ["limit_token=5", "5"],
  ])("still hides the value in %s", (text, value) => {
    expect(redactDurableCommand(text)).toMatchObject({ redacted: true })
    expect(redactDurableOutput(text).value).not.toContain(`=${value}`)
  })

  it("shows a plain number or true/false after each counting word, in every assignment form and case", () => {
    const hidden: string[] = []
    for (const word of countingWords) for (const suffix of sensitiveSuffixes) for (const value of ["5", "0", "4096", "1.5", "true", "false", "TRUE"]) {
      for (const [prefix, name] of [[word, suffix], [`DB_${word}`.toUpperCase(), suffix.toUpperCase()]] as const) for (const text of plainValueForms(prefix, name, value)) {
        if (redactDurableCommand(text).value !== text || redactDurableOutput(text).value !== text) hidden.push(text)
      }
    }
    expect(hidden).toEqual([])
  })

  it("hides the value for the same forms when the word is not on the list or the value is not plain", () => {
    const shown: string[] = []
    const cases: [string, string, string][] = []
    for (const suffix of sensitiveSuffixes) {
      for (const word of ["limit", "rate", "db", "per", "use", "num", "maximum", "totals"]) for (const value of ["5", "true"]) cases.push([word, suffix, value])
      for (const word of countingWords) for (const value of ["hunter2", "5abc", "yes", "0x1f", "-"]) cases.push([word, suffix, value])
    }
    for (const [prefix, suffix, value] of cases) for (const text of plainValueForms(prefix, suffix, value)) {
      if (!redactDurableCommand(text).redacted) shown.push(text)
    }
    expect(shown).toEqual([])
  })

  // Differential against main: the prefixed flags are this change's own (main
  // does not match them); every other shape is one main's redactor hides. Each
  // must stay hidden whole, and split at every position across two terminal
  // reads. The plain-value exemption never shows a value that is not complete,
  // balanced and followed by a delimiter.
  const mainHides: Array<[string, string]> = [
    ["deploy --x-token fake-value-4f2a9c done", "fake-value-4f2a9c"],
    ["deploy --db-password=fake-value-4f2a9c done", "fake-value-4f2a9c"],
    ["deploy --npm-auth-token fake-value-4f2a9c", "fake-value-4f2a9c"],
    ["total-password=\"123456\"x", "123456"],
    ["has-secret='42'tail", "42"],
    ["{\"total-token\": \"123456\"x}", "123456"],
    ["{\"count-token\": \"123456\"extra}", "123456"],
    ["total-password=\"123456", "123456"],
    ["{\"total-token\": \"123456", "123456"],
  ]

  it.each(mainHides)("hides the value in %s", (text, value) => {
    expect(redactDurableOutput(text).value).not.toContain(value)
    expect(redactDurableCommand(text)).toMatchObject({ redacted: true })
  })

  it.each(mainHides)("hides the value in %s split at every position across two terminal reads", (text, value) => {
    const leaks: number[] = []
    for (let split = 1; split < text.length; split += 1) {
      const redactor = new TerminalOutputRedactor()
      const shown = `${redactor.push(text.slice(0, split))}${redactor.push(text.slice(split))}${redactor.flush()}`
      if (shown.includes(value)) leaks.push(split)
    }
    expect(leaks).toEqual([])
  })

  it("does not show a plain value the durable stream has only part of", () => {
    const redactor = new DurableOutputRedactor()
    expect(redactor.push("total_token=5")).toBe("")
    expect(redactor.peek()).not.toContain("=5")
    expect(`${redactor.push("abcsecret\n")}${redactor.flush()}`).not.toContain("5abcsecret")
  })

  it("is idempotent and keeps replacement markers stable", () => {
    const once = redactDurableText("token=one --api-key two")
    expect(redactDurableText(once.value)).toEqual({ ...once, truncated: false })
  })

  it("pre-bounds malformed and oversized untrusted input", () => {
    const result = redactDurableCommand(`--token=${"s".repeat(1_000_000)}`)
    expect(result.redacted).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.value.length).toBeLessThanOrEqual(maximumDurableCommandLength)
    expect(result.value).not.toContain("s".repeat(100))
    expect(redactDurableOutput({ toString: () => { throw new Error("unsafe") } })).toEqual({
      value: "[Unprintable text]",
      redacted: false,
      truncated: false,
    })
  })

  it("redacts complete comma and escaped-quote assignment values", () => {
    const input = String.raw`TOKEN=left,right {"token":"left\"right-secret","safe":"visible"}`
    const result = redactDurableText(input)

    expect(result.value).toBe(
      String.raw`TOKEN=[REDACTED] {"token":"[REDACTED]","safe":"visible"}`,
    )
    expect(result.value).not.toMatch(/left|right-secret/)
  })

  it.each(escapedFlagValues)("hides a flag value with escapes whole: $text", ({ text, expected }) => {
    expect(redactDurableOutput(text).value).toBe(expected)
    expect(redactDurableCommand(text).value).toBe(expected)
  })

  it("does not retain a JWT fragment crossing the durable bound", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJib3VuZGFyeSJ9.signatureSecret"
    const result = redactDurableText(`${"a".repeat(maximumDurableTextLength - 8)}${jwt}`)

    expect(result.truncated).toBe(true)
    expect(result.value.length).toBeLessThanOrEqual(maximumDurableTextLength)
    expect(result.value).not.toContain("eyJhbG")
  })

  it("preserves bounded safe text while guarding secret suffixes that cross the cap", () => {
    const safe = redactDurableText("a".repeat(maximumDurableTextLength + 4_096))
    expect(safe.truncated).toBe(true)
    expect(safe.value.length).toBe(maximumDurableTextLength)
    expect(safe.value.startsWith("a".repeat(maximumDurableTextLength - 1))).toBe(true)

    for (const candidate of [
      "ghp_crossingKnownTokenSecret",
      "TOKEN=crossing-assignment-secret",
    ]) {
      const visibleFragment = candidate.slice(0, Math.ceil(candidate.length / 2))
      const prefix = `${"a".repeat(maximumDurableTextLength - visibleFragment.length - 1)} `
      const result = redactDurableText(`${prefix}${candidate}`)
      expect(result.truncated).toBe(true)
      expect(result.value).not.toContain(visibleFragment)
      expect(result.value.length).toBeLessThanOrEqual(maximumDurableTextLength)
    }

    const url = "https://user:crossing-url-password@example.test"
    const urlFragment = "https://user:crossing-url-pass"
    const urlPrefix = `${"a".repeat(maximumDurableTextLength - urlFragment.length - 1)} `
    const crossingUrl = redactDurableText(`${urlPrefix}${url}`)
    expect(crossingUrl.truncated).toBe(true)
    expect(crossingUrl.value).not.toContain("crossing-url-pass")
    expect(crossingUrl.value).toContain("https://[REDACTED]")

    for (const fragment of ["ghp_ab", "eyJab"]) {
      const prefix = `${"a".repeat(maximumDurableTextLength - fragment.length - 1)} `
      const result = redactDurableText(`${prefix}${fragment}overflow-secret`)
      expect(result.truncated).toBe(true)
      expect(result.value).not.toContain(fragment.slice(0, -1))
    }
  })

  it("streams safe complete LF and CRLF records without delay", () => {
    const stream = new DurableOutputRedactor()
    expect(stream.push("first line\nsecond line\r\n")).toBe("first line\nsecond line\r\n")
    expect(stream.flush()).toBe("")
  })

  it("holds split secret records until their value can be redacted", () => {
    const stream = new DurableOutputRedactor()
    expect(stream.push("token=")).toBe("")
    expect(stream.push("split-stream-secret\r\nnext")).toBe("token=[REDACTED]\r\n")
    expect(stream.flush()).toBe("next")
  })

  it("flushes sanitized output when a provider supplies no aggregate", () => {
    const stream = new DurableOutputRedactor()
    expect(stream.push("password=no-aggregate-secret")).toBe("")
    expect(stream.flush()).toBe("password=[REDACTED]")
  })

  it("peeks the sanitized remainder without consuming it", () => {
    const stream = new DurableOutputRedactor()
    expect(stream.push("password=peek-secret")).toBe("")
    expect(stream.peek()).toBe("password=[REDACTED]")
    expect(stream.peek()).toBe("password=[REDACTED]")
    expect(stream.flush()).toBe("password=[REDACTED]")
    expect(stream.peek()).toBe("")
    stream.push(`token=${"s".repeat(maximumStreamingOutputBufferLength + 1)}`)
    expect(stream.peek()).toBe("")
  })

  it("bounds pathological no-newline records without leaking later fragments", () => {
    const stream = new DurableOutputRedactor()
    const emitted = stream.push(`token=${"s".repeat(maximumStreamingOutputBufferLength + 1)}`)
    expect(emitted).toBe("[Long command output line omitted]\n")
    expect(emitted).not.toContain("s".repeat(100))
    expect(stream.push("continuation-secret")).toBe("")
    expect(stream.push("\r\nsafe line\n")).toBe("safe line\n")
    expect(stream.flush()).toBe("")
  })
})

// Review of 7ba25ba8, executed by the reviewer; each also found by the
// differential fuzz in secret-redaction-prefixed-differential.test.ts.
describe("prefixed names across the terminal's reads", () => {
  function run(reads: readonly string[]): string {
    const redactor = new TerminalOutputRedactor()
    return reads.map((read) => redactor.push(read)).join("") + redactor.flush()
  }

  // The same flag values, and long ones that outgrow the carry, split at every
  // point across two reads.
  const longEscapedFlagValues = ["\"", "'"].flatMap((quote) => ["--token ", "--token=", "--x-token "].map((flag) => ({
    text: `run ${flag}${quote}${"zqxjwvkm".repeat(34)}\\${quote}mkqz${quote} -s`,
    expected: `run ${flag}${quote}[REDACTED]${quote} -s`,
  })))
  it.each([...escapedFlagValues, ...longEscapedFlagValues])("hides a flag value with escapes split at every point: $text", ({ text, expected }) => {
    const wrong: string[] = []
    for (let at = 1; at < text.length; at += 1) {
      const shown = run([text.slice(0, at), text.slice(at)])
      if (shown !== expected) wrong.push(`${at}: ${shown.slice(-60)}`)
    }
    expect(wrong).toEqual([])
  })

  it("hides a prefixed flag's value that runs past the carry", () => {
    const value = "a".repeat(247)
    const shown = run([`--x-token ${value}`, "a".repeat(20), " done\n"])
    expect(shown).not.toContain("aaa")
    expect(shown).toContain(" done\n")
  })

  it("holds a dotted prefix left at the end of a read", () => {
    const shown = run(["--x.", "token fake-value done\n"])
    expect(shown).not.toContain("fake-value")
    expect(shown).toContain(" done\n")
  })

  // Found by the differential fuzz while fixing the three above.
  it("hides a one-dash prefixed flag's value, and shows a complete counting one", () => {
    expect(redactDurableOutput("tool -db-password hunter2zz -s").value).toBe("tool -db-password [REDACTED] -s")
    expect(redactDurableOutput("tool -max-token 5 -s").value).toBe("tool -max-token 5 -s")
    expect(run(["tool -db-pass", "word hunter2zz -s\n"])).toBe("tool -db-password [REDACTED] -s\n")
  })

  it("keeps what follows a long quoted value once its quote closes", () => {
    const shown = run([`{"npm.secret_key":"${"q".repeat(300)}","safe":"visibl`, "e\"}\n"])
    expect(shown).toBe('{"npm.secret_key":"[REDACTED]","safe":"visible"}\n')
  })

  it("keeps the set quote before a name that arrives in the next read", () => {
    expect(run(['set "', "min-secret_key=2979\r\n"])).not.toContain("2979")
    expect(run(['set "', 'is-API_KEY=False"\n'])).toBe('set "is-API_KEY=False"\n')
  })

  it("does not show a counting value whose line began before a flush", () => {
    const redactor = new TerminalOutputRedactor()
    const shown = redactor.push('set "COUNT-') + redactor.flush() + redactor.push("IS-PRIVATE-KEY=TRUE\n") + redactor.flush()
    expect(shown).not.toContain("TRUE")
  })

  it("hides a value main hid after a flush left the property's -D behind", () => {
    const redactor = new TerminalOutputRedactor()
    const shown = redactor.push("java -") + redactor.flush() + redactor.push("Dpassword=403 -jar app.jar\n") + redactor.flush()
    expect(shown).not.toContain("403")
    expect(shown).toContain(" -jar app.jar\n")
  })

  it("keeps what follows a long quoted value whose quote closed at the end of a read", () => {
    const shown = run([`{"x.secret_key":"${"q".repeat(300)}"`, ',"safe":"visible"}\n'])
    expect(shown).toBe('{"x.secret_key":"[REDACTED]","safe":"visible"}\n')
  })

  it("does not take a value in an unclosed set quote as complete", () => {
    expect(run(['set "total-password=123456']).includes("123456")).toBe(false)
    expect(redactDurableOutput('set "total-password=123456').value).not.toContain("123456")
    expect(redactDurableCommand('set "total-password=123456').value).not.toContain("123456")
  })
})

// Review of dbce5143, and what the widened differential fuzz found with it: a
// quoted value stays hidden until its unescaped closing quote, across spaces,
// tabs, CR, LF, ; and reads, in every redactor. A quote that never closes
// hides the rest of the record, and the streams carry it into the next one.
describe("quoted values across spaces, line breaks and reads", () => {
  function run(reads: readonly string[]): string {
    const redactor = new TerminalOutputRedactor()
    return reads.map((read) => redactor.push(read)).join("") + redactor.flush()
  }
  function stream(reads: readonly string[]): string {
    const redactor = new DurableOutputRedactor()
    return reads.map((read) => redactor.push(read)).join("") + redactor.flush()
  }
  // Every way of reading a text in two or three reads.
  function splits(text: string): string[][] {
    const all: string[][] = []
    for (let first = 1; first < text.length; first += 1) {
      all.push([text.slice(0, first), text.slice(first)])
      for (let second = first + 1; second < text.length; second += 1) {
        all.push([text.slice(0, first), text.slice(first, second), text.slice(second)])
      }
    }
    return all
  }

  const closed: Array<{ text: string, expected: string }> = [
    { text: 'NPM_TOKEN="zqx jwvk" -s\n', expected: 'NPM_TOKEN="[REDACTED]" -s\n' },
    { text: 'run --npm-token="zqx\rjwvk" -s\n', expected: 'run --npm-token="[REDACTED]" -s\n' },
    { text: 'run --npm-token="zqx\r\njwvk" -s\n', expected: 'run --npm-token="[REDACTED]" -s\n' },
    { text: "export X_SECRET='zqx\tjwvk;=:é' -s\n", expected: "export X_SECRET='[REDACTED]' -s\n" },
    { text: "token=$'zqx \\'jwvk' -s\n", expected: "token=$'[REDACTED]' -s\n" },
    { text: 'set "DB_PASSWORD=zqx jwvk"\n', expected: 'set "DB_PASSWORD=[REDACTED]"\n' },
    { text: '{"x_token": "zqx \\" jwvk", "safe": "visible"}\n', expected: '{"x_token": "[REDACTED]", "safe": "visible"}\n' },
  ]

  it.each(closed)("hides $text whole in the durable redactors", ({ text, expected }) => {
    expect(redactDurableCommand(text)).toMatchObject({ value: expected, redacted: true })
    expect(redactDurableOutput(text).value).toBe(expected)
    expect(redactDurableText(text).value).toBe(expected)
  })

  it.each(closed)("hides $text in every two- and three-read split of the terminal", ({ text, expected }) => {
    const wrong = splits(text).filter((reads) => run(reads) !== expected).map((reads) => JSON.stringify(reads))
    expect(wrong).toEqual([])
  })

  it.each(closed)("hides $text in every two- and three-read split of the durable stream", ({ text }) => {
    const wrong = splits(text).filter((reads) => {
      const shown = stream(reads)
      return /zq|qx|jw|wv|vk/u.test(shown) || !/ -s\n$|"safe": "visible"\}\n$|"\n$/u.test(shown)
    }).map((reads) => JSON.stringify(reads))
    expect(wrong).toEqual([])
  })

  it("keeps a quoted value open across an idle flush", () => {
    const redactor = new TerminalOutputRedactor()
    const shown = redactor.push('NPM_TOKEN="zqx ') + redactor.flush() + redactor.push('jwvk" -s\n') + redactor.flush()
    expect(shown).toBe('NPM_TOKEN="[REDACTED]" -s\n')
  })

  it("keeps a long quoted value open across line breaks until it closes", () => {
    const value = `${"zqx ".repeat(80)}\r\n${"jwvk\n".repeat(80)}`
    const shown = run([`export X_TOKEN="${value.slice(0, 300)}`, value.slice(300), '" -s\n'])
    expect(shown).toBe('export X_TOKEN="[REDACTED]" -s\n')
  })

  it("hides the rest of the record after a quote that never closes, and carries it into the next", () => {
    expect(redactDurableOutput('NPM_TOKEN="zqx jwvk\nnext zqx\n').value).toBe('NPM_TOKEN="[REDACTED]"\n')
    expect(redactDurableCommand('run --npm-token "zqx\rjwvk').value).toBe('run --npm-token "[REDACTED]"')
    expect(redactDurableCommand('set "X_PASSWORD=zqx\njwvk').value).toBe('set "X_PASSWORD=[REDACTED]"')
    expect(stream(['NPM_TOKEN="zqx jwvk\n', "still jwvk\n", 'jwvk" -s\n', "after\n"])).toBe('NPM_TOKEN="[REDACTED]"\n -s\nafter\n')
    expect(run(['NPM_TOKEN="zqx jwvk\r\n', "still jwvk\r\n", 'jwvk" -s\r\n'])).toBe('NPM_TOKEN="[REDACTED]" -s\r\n')
  })

  it("carries a quote left open by an omitted long record into the next record", () => {
    const long = "a".repeat(maximumStreamingOutputBufferLength + 10)
    expect(stream([`${long} NPM_TOKEN="zqx\n`, 'jwvk" -s\n'])).toBe("[Long command output line omitted]\n -s\n")
    expect(stream([`${long} NPM_TOK`, 'EN="zqx', "\n", 'jwvk" -s\n'])).toBe("[Long command output line omitted]\n -s\n")
    expect(stream([`${long} NPM_TOKEN="zqx" ok\n`, "visible\n"])).toBe("[Long command output line omitted]\nvisible\n")
  })

  it("hides quoted values in workspace approval and thread copies", () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.approvals[0]!.command = 'run --npm-token="zqx\rjwvk" -s'
    snapshot.approvals[0]!.operation = 'Run with NPM_TOKEN="zqx\r\njwvk"'
    const sessionId = snapshot.sessions[0]!.id
    snapshot.thread.push(
      { id: "tool-quoted", sessionId, kind: "tool", tool: "command", status: "completed", title: 'run --npm-token "zqx jwvk" -s', output: 'X_SECRET="zqx\njwvk" -s\n', createdAt: "2026-09-24T12:00:00.000Z" },
      { id: "user-quoted", sessionId, kind: "user", body: "export X_PASSWORD='zqx\rjwvk' now", createdAt: "2026-09-24T12:00:00.000Z" },
    )
    const copies = redactWorkspaceCopies(snapshot)
    const shown = JSON.stringify({ approval: copies.approvals[0], thread: copies.thread.filter((item) => item.id.endsWith("-quoted")) })
    expect(shown).not.toMatch(/jwvk/u)
    expect(copies.approvals[0]).toMatchObject({ risk: "hard-gate", command: 'run --npm-token="[REDACTED]" -s' })
    expect(copies.thread).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "tool-quoted", title: 'run --npm-token "[REDACTED]" -s', output: 'X_SECRET="[REDACTED]" -s\n' }),
      expect.objectContaining({ id: "user-quoted", body: "export X_PASSWORD='[REDACTED]' now" }),
    ]))
  })

  // Found by the widened fuzz at 200,000 cases on seed 424242.
  it("keeps the line after a closed set quote read past an idle flush", () => {
    const redactor = new TerminalOutputRedactor()
    const shown = redactor.push("a".repeat(60)) + redactor.flush() + redactor.push(`${"a".repeat(30)} set "DB-ACCESS_TOKEN=False"\nvisible output\n`) + redactor.flush()
    expect(shown).toContain("\nvisible output\n")
    expect(shown).not.toContain("False")
  })

  it("does not show a counting value in a set quote whose name outgrew the carry", () => {
    const name = `${"a.".repeat(1_400)}min.auth-token`
    const text = `set "${name}=339.726\n`
    expect(run([text.slice(0, 261), text.slice(261)])).not.toContain("339")
  })

  it("keeps dropping a name that outgrew the carry while it still grows into a sensitive name", () => {
    const name = `${"a.".repeat(140)}CREDENTIAL`
    expect(run([`{"${name}`, 'S":"zqxjwvk","safe":"visible"}\n'])).toBe(`{"${name}S":"[REDACTED]","safe":"visible"}\n`)
    expect(run([`${"a.".repeat(140)}SECRET`, "_KEY=zqxjwvk -s\n"])).toBe(`${"a.".repeat(140)}SECRET_KEY=[REDACTED] -s\n`)
    expect(run([`${"a.".repeat(140)}TOKEN`, "_BUDGET=4096\n"])).toBe(`${"a.".repeat(140)}TOKEN_BUDGET=4096\n`)
  })
})

// Security review of 95302320, and what the fuzz widened to substitutions
// found with it: a command substitution, $(…) or `…`, runs to its matching
// closing delimiter across spaces, line breaks and reads, nested or inside
// quotes, and a substitution that never closes hides the rest of the record
// and carries into the next one, as an open quote does.
describe("command substitutions across spaces, line breaks and reads", () => {
  function run(reads: readonly string[]): string {
    const redactor = new TerminalOutputRedactor()
    return reads.map((read) => redactor.push(read)).join("") + redactor.flush()
  }
  function stream(reads: readonly string[]): string {
    const redactor = new DurableOutputRedactor()
    return reads.map((read) => redactor.push(read)).join("") + redactor.flush()
  }
  function splits(text: string): string[][] {
    const all: string[][] = []
    for (let first = 1; first < text.length; first += 1) {
      all.push([text.slice(0, first), text.slice(first)])
      for (let second = first + 1; second < text.length; second += 1) {
        all.push([text.slice(0, first), text.slice(first, second), text.slice(second)])
      }
    }
    return all
  }

  const closed: Array<{ text: string, expected: string }> = [
    { text: "TOKEN=$(get zqx jwvk) -s\n", expected: "TOKEN=[REDACTED] -s\n" },
    { text: "run --token `get zqx jwvk` -s\n", expected: "run --token [REDACTED] -s\n" },
    { text: "export X_TOKEN=$(get $(zqx\tjwvk) \"m)q\" `kz\nvw`) -s\n", expected: "export X_TOKEN=[REDACTED] -s\n" },
    { text: "NPM_TOKEN=\"$(get \"zqx jwvk\")\" -s\n", expected: "NPM_TOKEN=\"[REDACTED]\" -s\n" },
    { text: "X_PASSWORD=$(cat <<'EOF'\nzqx jwvk\nEOF\n) -s\n", expected: "X_PASSWORD=[REDACTED] -s\n" },
    { text: "token=`get \\`zqx jwvk\\` mq` -s\n", expected: "token=[REDACTED] -s\n" },
    { text: "run --db-password=zq$(get x\r\njwvk)vk -s\n", expected: "run --db-password=[REDACTED] -s\n" },
    { text: "{\"x_token\": \"$(get \\\"zqx jwvk\\\")\", \"safe\": \"visible\"}\n", expected: "{\"x_token\": \"[REDACTED]\", \"safe\": \"visible\"}\n" },
    { text: "api_key: $(vault read zqx jwvk)\n", expected: "api_key: [REDACTED]\n" },
    // Security review of 779406a3: process substitutions and parameter
    // expansions, and the rest of the reader's table.
    { text: "NPM_TOKEN=<(printf zqx jwvk) -s\n", expected: "NPM_TOKEN=[REDACTED] -s\n" },
    { text: "NPM_TOKEN=${VAR:-zqx jwvk} -s\n", expected: "NPM_TOKEN=[REDACTED] -s\n" },
    { text: "run --token >(tee zqx jwvk) -s\n", expected: "run --token [REDACTED] -s\n" },
    { text: "X_TOKEN=\"${VAR:-zqx \"jwvk\" {m}}\" -s\n", expected: "X_TOKEN=\"[REDACTED]\" -s\n" },
    { text: "TOKEN=$((zqx + (jwvk * 2))) -s\n", expected: "TOKEN=[REDACTED] -s\n" },
    { text: "TOKEN=$((get zqx) jwvk) -s\n", expected: "TOKEN=[REDACTED] -s\n" },
    { text: "token=$\"zqx jwvk\" -s\n", expected: "token=$\"[REDACTED]\" -s\n" },
    { text: "NPM_TOKEN=(zqx \"jwvk mq\" $(get kz)) -s\n", expected: "NPM_TOKEN=([REDACTED]) -s\n" },
  ]

  it.each(closed)("hides $text whole in the durable redactors", ({ text, expected }) => {
    expect(redactDurableCommand(text)).toMatchObject({ value: expected, redacted: true })
    expect(redactDurableOutput(text).value).toBe(expected)
    expect(redactDurableText(text).value).toBe(expected)
  })

  it.each(closed)("hides $text in every two- and three-read split of the terminal", ({ text, expected }) => {
    const wrong = splits(text).filter((reads) => run(reads) !== expected).map((reads) => JSON.stringify(reads))
    expect(wrong).toEqual([])
  })

  it.each(closed)("hides $text in every two- and three-read split of the durable stream", ({ text }) => {
    const wrong = splits(text).filter((reads) => {
      const shown = stream(reads)
      return /zq|qx|jw|wv|vk|kz|mq|get|vault/u.test(shown) || !/ -s\n$|"safe": "visible"\}\n$|: \[REDACTED\]\n$/u.test(shown)
    }).map((reads) => JSON.stringify(reads))
    expect(wrong).toEqual([])
  })

  it("keeps a substitution open across an idle flush", () => {
    const redactor = new TerminalOutputRedactor()
    const shown = redactor.push("TOKEN=$(get zqx ") + redactor.flush() + redactor.push("jwvk) -s\n") + redactor.flush()
    expect(shown).toBe("TOKEN=[REDACTED] -s\n")
  })

  it("keeps a long substitution open across line breaks until it closes", () => {
    const value = `$(get ${"zqx ".repeat(80)}\r\n${"jwvk\n".repeat(80)}`
    const shown = run([`export X_TOKEN=${value.slice(0, 300)}`, value.slice(300), ") -s\n"])
    expect(shown).toBe("export X_TOKEN=[REDACTED] -s\n")
    expect(run([`run --token \`${"zqx ".repeat(80)}`, "jwvk\n`", " -s\n"])).toBe("run --token [REDACTED] -s\n")
  })

  it("hides the rest of the record after a substitution that never closes, and carries it into the next", () => {
    expect(redactDurableOutput("TOKEN=$(get zqx jwvk\nnext zqx\n").value).toBe("TOKEN=[REDACTED]\n")
    expect(redactDurableCommand("run --token `get zqx\rjwvk").value).toBe("run --token [REDACTED]")
    expect(redactDurableCommand("X_TOKEN=$(get $(zqx) \"m q").value).toBe("X_TOKEN=[REDACTED]")
    expect(stream(["TOKEN=$(get zqx jwvk\n", "still $(jwvk)\n", "jwvk) -s\n", "after\n"])).toBe("TOKEN=[REDACTED]\n -s\nafter\n")
    expect(run(["TOKEN=$(get zqx jwvk\r\n", "still jwvk\r\n", "jwvk) -s\r\n"])).toBe("TOKEN=[REDACTED] -s\r\n")
  })

  it("carries a substitution left open by an omitted long record into the next record", () => {
    const long = "a".repeat(maximumStreamingOutputBufferLength + 10)
    expect(stream([`${long} NPM_TOKEN=$(zqx\n`, "jwvk) -s\n"])).toBe("[Long command output line omitted]\n -s\n")
    expect(stream([`${long} NPM_TOKEN=\`zqx\n`, "jwvk` -s\n"])).toBe("[Long command output line omitted]\n -s\n")
  })

  it("hides substitutions in workspace approval and thread copies", () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.approvals[0]!.command = "run --token $(vault read zqx jwvk) -s"
    snapshot.approvals[0]!.operation = "Run with NPM_TOKEN=`get zqx\r\njwvk`"
    const sessionId = snapshot.sessions[0]!.id
    snapshot.thread.push(
      { id: "tool-substituted", sessionId, kind: "tool", tool: "command", status: "completed", title: "run --token `get zqx jwvk` -s", output: "X_SECRET=$(get zqx\njwvk) -s\n", createdAt: "2026-09-24T12:00:00.000Z" },
      { id: "user-substituted", sessionId, kind: "user", body: "export X_PASSWORD=$(get \"zqx jwvk\") now", createdAt: "2026-09-24T12:00:00.000Z" },
    )
    const copies = redactWorkspaceCopies(snapshot)
    const shown = JSON.stringify({ approval: copies.approvals[0], thread: copies.thread.filter((item) => item.id.endsWith("-substituted")) })
    expect(shown).not.toMatch(/jwvk/u)
    expect(copies.approvals[0]).toMatchObject({ risk: "hard-gate", command: "run --token [REDACTED] -s" })
    expect(copies.thread).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "tool-substituted", title: "run --token [REDACTED] -s", output: "X_SECRET=[REDACTED] -s\n" }),
      expect.objectContaining({ id: "user-substituted", body: "export X_PASSWORD=[REDACTED] now" }),
    ]))
  })

  // Security review of 779406a3: a nested value read one character at a time
  // took time growing with the square of its depth, since each read copied
  // the whole nesting. The check is a ratio, not a time limit: four times the
  // reads must take well under the sixteen times a square would.
  it.each([
    ["terminal", (reads: number) => {
      const redactor = new TerminalOutputRedactor()
      let shown = redactor.push("TOKEN=$(")
      for (let index = 0; index < reads; index += 1) shown += redactor.push("(")
      return `${shown}${redactor.push(`${")".repeat(reads + 1)} -s\n`)}${redactor.flush()}`
    }, "TOKEN=[REDACTED] -s\n"],
    ["durable output stream", (reads: number) => {
      const redactor = new DurableOutputRedactor()
      let shown = redactor.push("TOKEN=$(get\n")
      for (let index = 0; index < reads; index += 1) shown += redactor.push("(")
      return `${shown}${redactor.push(`${")".repeat(reads + 1)} -s\n`)}${redactor.flush()}`
    }, "TOKEN=[REDACTED]\n -s\n"],
  ] as const)("reads a deeply nested value one character at a time in linear time in the %s", (name, read, expected) => {
    const smaller = 4_000
    const larger = 4 * smaller
    expect(read(smaller)).toBe(expected)
    // The fastest of five runs, so a pause in one run does not decide it.
    const fastest = (reads: number) => {
      let best = Number.POSITIVE_INFINITY
      for (let round = 0; round < 5; round += 1) {
        const started = performance.now()
        read(reads)
        best = Math.min(best, performance.now() - started)
      }
      return best
    }
    const small = fastest(smaller)
    const large = fastest(larger)
    const measured = `${name}: ${smaller} reads ${small.toFixed(2)} ms, ${larger} reads ${large.toFixed(2)} ms, ratio ${(large / small).toFixed(2)}`
    if (process.env.REDACTION_TIMING_REPORT) appendFileSync(process.env.REDACTION_TIMING_REPORT, `${measured}\n`)
    expect(large / small, measured).toBeLessThan(8)
  })

  it("leaves a substitution after a name that is not sensitive alone", () => {
    for (const text of ["TOKEN_BUDGET=$(nproc) make", "echo $(date) token count", "tool --no-token `get x y` build"]) {
      expect(redactDurableCommand(text)).toEqual({ value: text, redacted: false, truncated: false })
      expect(run([text])).toBe(text)
    }
  })
})

// A quote in the middle of a value word opens, as bash reads one word:
// TOKEN=ab"c d" is the value ab"c d". A quote right before the name, as in
// cmd's set "NAME=value", is still open at the value, which ends at its
// closing quote. The set rows were green before this change and must stay so.
describe("quotes in the middle of a word and around a name", () => {
  function run(reads: readonly string[]): string {
    const redactor = new TerminalOutputRedactor()
    return reads.map((read) => redactor.push(read)).join("") + redactor.flush()
  }
  function stream(reads: readonly string[]): string {
    const redactor = new DurableOutputRedactor()
    return reads.map((read) => redactor.push(read)).join("") + redactor.flush()
  }
  function splits(text: string): string[][] {
    const all: string[][] = []
    for (let first = 1; first < text.length; first += 1) {
      all.push([text.slice(0, first), text.slice(first)])
      for (let second = first + 1; second < text.length; second += 1) {
        all.push([text.slice(0, first), text.slice(first, second), text.slice(second)])
      }
    }
    return all
  }

  type Row = { text: string, expected: string, streamed?: string }
  const midWord: Row[] = [
    { text: "TOKEN=zq\"x jw\"vk -s\n", expected: "TOKEN=[REDACTED] -s\n" },
    { text: "TOKEN=zq'x jw'vk -s\n", expected: "TOKEN=[REDACTED] -s\n" },
    { text: "TOKEN=zq$'x jw'vk -s\n", expected: "TOKEN=[REDACTED] -s\n" },
    { text: "run --token zq$\"x jw\" -s\n", expected: "run --token [REDACTED] -s\n" },
    { text: "export X_SECRET=zq\"x\njw\" -s\n", expected: "export X_SECRET=[REDACTED] -s\n", streamed: "export X_SECRET=[REDACTED]\n -s\n" },
    { text: "echo \"NPM_TOKEN=zqx jwvk\" -s\n", expected: "echo \"NPM_TOKEN=[REDACTED]\" -s\n" },
  ]
  // cmd's set "NAME=value", from the existing tests.
  const setQuote: Row[] = [
    { text: "set \"DB_PASSWORD=zqxjwvk\"\n", expected: "set \"DB_PASSWORD=[REDACTED]\"\n" },
    { text: "set \"DB_PASSWORD=zqx jwvk\"\n", expected: "set \"DB_PASSWORD=[REDACTED]\"\n" },
    { text: "set 'X_TOKEN=zqxjwvk' & echo -s\n", expected: "set 'X_TOKEN=[REDACTED]' & echo -s\n" },
    { text: "set \"PASSWORD=cmd secret with spaces\"\n", expected: "set \"PASSWORD=[REDACTED]\"\n" },
    { text: "set \"is-API_KEY=False\"\n", expected: "set \"is-API_KEY=False\"\n" },
    { text: "set \"DB-ACCESS_TOKEN=zqxjwvk\"\nvisible output\n", expected: "set \"DB-ACCESS_TOKEN=[REDACTED]\"\nvisible output\n" },
  ]
  const rows = [...midWord, ...setQuote]

  it.each(rows)("hides $text whole in the durable redactors", ({ text, expected }) => {
    expect(redactDurableCommand(text).value).toBe(expected)
    expect(redactDurableOutput(text).value).toBe(expected)
    expect(redactDurableText(text).value).toBe(expected)
  })

  it.each(rows)("hides $text in every two- and three-read split of the terminal", ({ text, expected }) => {
    const wrong = splits(text).filter((reads) => run(reads) !== expected).map((reads) => JSON.stringify(reads))
    expect(wrong).toEqual([])
  })

  // The stream emits whole records, so a value open across a line break ends
  // its record as the replacement and the rest of the value is dropped from
  // the next (streamed).
  it.each(rows)("hides $text in every two- and three-read split of the durable stream", ({ text, expected, streamed }) => {
    const wrong = splits(text).filter((reads) => stream(reads) !== (streamed ?? expected)).map((reads) => JSON.stringify(reads))
    expect(wrong).toEqual([])
  })

  it("keeps the existing set quote cases", () => {
    expect(run(['set "', "min-secret_key=2979\r\n"])).not.toContain("2979")
    expect(run(['set "', 'is-API_KEY=False"\n'])).toBe('set "is-API_KEY=False"\n')
    expect(redactDurableOutput('set "total-password=123456').value).not.toContain("123456")
    expect(redactDurableCommand('set "total-password=123456').value).not.toContain("123456")
    expect(run(['set "total-password=123456'])).not.toContain("123456")
    expect(redactDurableCommand('set "X_PASSWORD=zqx\njwvk').value).toBe('set "X_PASSWORD=[REDACTED]"')
    const redactor = new TerminalOutputRedactor()
    const shown = redactor.push("a".repeat(60)) + redactor.flush() + redactor.push(`${"a".repeat(30)} set "DB-ACCESS_TOKEN=False"\nvisible output\n`) + redactor.flush()
    expect(shown).toContain("\nvisible output\n")
    expect(shown).not.toContain("False")
  })

  // Ruled by fetzy 2026-09-24: where the terminal has lost what came before a
  // name (an idle flush in the middle of it, or a name longer than the carry),
  // a quote in the value opens a quote, failing closed. The accepted cost: a
  // set "NAME=value" split there may hide the output that follows until
  // another quote arrives. The value itself stays hidden.
  it("hides the value of a set quote whose name began before an idle flush", () => {
    const redactor = new TerminalOutputRedactor()
    const shown = redactor.push('set "DB-') + redactor.flush() + redactor.push('PASSWORD=zqxjwvk"\nvisible output\n') + redactor.flush()
    expect(shown).not.toMatch(/zq|qx|jw|wv|vk/u)
  })

  it("opens a quote in the middle of a value whose name began before an idle flush", () => {
    const redactor = new TerminalOutputRedactor()
    const shown = redactor.push("curl --IS__COUNT") + redactor.flush() + redactor.push("_COOKIE=jw'qv$((z'vk -s") + redactor.flush()
    expect(shown).not.toMatch(/jw|qv|vk/u)
    expect(shown).toMatch(/ -s$/u)
  })

  it("reads a quoted value on to its delimiter after an idle flush in its name", () => {
    const redactor = new TerminalOutputRedactor()
    const shown = redactor.push("coun") + redactor.flush() + redactor.push("t.github_token=$'qv))x'xq\r\n") + redactor.flush()
    expect(shown).not.toMatch(/qv|xq/u)
    expect(shown).toMatch(/\r\n$/u)
  })
})
