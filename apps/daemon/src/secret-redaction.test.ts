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
