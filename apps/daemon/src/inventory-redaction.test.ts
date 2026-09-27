import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { toolInventoryEntrySchema } from "@getdomovoi/protocol"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { inventoryShellWords, redactInventoryArgv, redactInventoryText } from "./inventory-redaction.js"

// The protocol backstop judges each emitted text; a hook entry is the smallest
// shape that carries a free-text command.
function backstopAccepts(command: string): boolean {
  return toolInventoryEntrySchema.safeParse({
    kind: "hook", file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true, event: "PreToolUse", command,
  }).success
}

describe("redactInventoryText", () => {
  it.each([
    ["NODE_ENV=production pnpm build", "NODE_ENV=[REDACTED] pnpm build"],
    ["DATABASE_URL=x node app.js", "DATABASE_URL=[REDACTED] node app.js"],
    ["PGPASSWORD=x psql -h db", "PGPASSWORD=[REDACTED] psql -h db"],
    ["export FOO=bar && run", "export FOO=[REDACTED] && run"],
    ["API_KEY=\"a b\" run", "API_KEY=\"[REDACTED]\" run"],
    ["API_KEY='a b' run", "API_KEY='[REDACTED]' run"],
    ["API_KEY=a\\ b run", "API_KEY=[REDACTED] run"],
    ["env \"PASSWORD=correct horse\" run", "env \"PASSWORD=[REDACTED]\" run"],
    ["sh -c 'TOKEN=abc run'", "sh -c 'TOKEN=[REDACTED]'"],
    ["cd x;SECRET=1 make", "cd x;SECRET=[REDACTED] make"],
    ["curl https://tok@example.com/x", "curl https://[REDACTED]@example.com/[REDACTED]"],
    ["curl https://user:pass@example.com:8443/x", "curl https://[REDACTED]@example.com:8443/[REDACTED]"],
    ["curl 'https://example.com/p?key=abc&mode=fast'", "curl 'https://example.com/[REDACTED]?key=[REDACTED]&mode=[REDACTED]'"],
    ["open https://example.com/cb#access_token=zzz", "open https://example.com/[REDACTED]#access_token=[REDACTED]"],
    // A query or fragment part without an equals sign is a value too.
    ["open https://example.com/cb#opaque-fragment-secret", "open https://example.com/[REDACTED]#[REDACTED]"],
    ["curl 'https://example.com/p?token-without-equals'", "curl 'https://example.com/[REDACTED]?[REDACTED]'"],
    ["curl 'https://example.com/p?a=1&bare;b=&d#x;c=2'", "curl 'https://example.com/[REDACTED]?a=[REDACTED]&[REDACTED];b=&[REDACTED]#[REDACTED];c=[REDACTED]'"],
    // The whole path after the host is a value: a webhook path is its token.
    ["curl -X POST https://hooks.example.com/services/T0/B0/XXXX", "curl -X POST https://hooks.example.com/[REDACTED]"],
    ["curl 'https://h.example.com:8443/a/b?key=abc#frag'", "curl 'https://h.example.com:8443/[REDACTED]?key=[REDACTED]#[REDACTED]'"],
    // A `?` is a pattern character, so it is quoted when written again.
    ["curl https://example.com/?q=1", "curl https://example.com/'?q=[REDACTED]'"],
    ["https://example.com/path", "https://example.com/[REDACTED]"],
    ["https://example.com/p?a=", "https://example.com/[REDACTED]'?a='"],
    // A URL is the whole shell word, quoted runs included, and its assembled
    // path goes whole; the quotes the word opens or closes stay balanced.
    ["curl https://hooks.example.com/'opaque-secret' x", "curl https://hooks.example.com/[REDACTED] x"],
    ["curl https://h.example.com/'a'\"b\"/c x", "curl https://h.example.com/[REDACTED] x"],
    ["curl 'https://h.example.com/'s3cr3t-value x", "curl 'https://h.example.com/[REDACTED]' x"],
    ["curl \"https://h.example.com/\"'s3cr3t-value'?key=v x", "curl \"https://h.example.com/[REDACTED]?key=[REDACTED]\" x"],
    ["sh -c \"curl https://h.example.com/'s3cr3t-value' x\"", "sh -c \"curl https://h.example.com/[REDACTED] x\""],
    ["sh -c 'curl https://h.example.com/\"s3cr3t value\" x'", "sh -c 'curl https://h.example.com/[REDACTED] x'"],
    ["sh -c \"curl https://h.example.com/\\\"s3cr3t value\\\" x\"", "sh -c \"curl https://h.example.com/[REDACTED] x\""],
    // A shell escape in a header name is read before the name is matched.
    ["curl -H \"X\\`Foo: opaque-secret\" x", "curl -H \"X\\`Foo: [REDACTED]\" x"],
    ["curl -H \"X\\$Foo: s3cr3t-value\" x", "curl -H \"X\\$Foo: [REDACTED]\" x"],
    ["curl -H \"X\\\"Foo: s3cr3t-value\" x", "curl -H \"X\\\"Foo: [REDACTED]\" x"],
    ["curl -H X\\`Foo:s3cr3t-value x", "curl -H X\\`Foo:[REDACTED] x"],
    ["sh -c 'curl -H \"X\\`Foo: s3cr3t-value\" x'", "sh -c 'curl -H \"X\\`Foo: [REDACTED]\" x'"],
    // A header argument with a colon that still does not read as a header is
    // redacted whole.
    ["curl -H \"X Foo: s3cr3t-value\" x", "curl -H \"[REDACTED]\" x"],
    ["curl -H 'X(Foo): s3cr3t-value' x", "curl -H '[REDACTED]' x"],
    ["curl -H X\\\\Foo:s3cr3t-value x", "curl -H [REDACTED] x"],
    ["curl -H 'Authorization: Bearer tok' x", "curl -H 'Authorization: Bearer [REDACTED]' x"],
    // A header's value is redacted whatever the header is called.
    ["curl -H 'X-Custom: opaque-header-secret' x", "curl -H 'X-Custom: [REDACTED]' x"],
    ["curl --header \"X-Custom: a b\" x", "curl --header \"X-Custom: [REDACTED]\" x"],
    ["curl --proxy-header 'X-Custom: v' x", "curl --proxy-header 'X-Custom: [REDACTED]' x"],
    ["wget --header='X-Custom: v' x", "wget --header='X-Custom: [REDACTED]' x"],
    ["curl -H X-Custom:v x", "curl -H X-Custom:[REDACTED] x"],
    ["curl -H'X-Custom: v' x", "curl -H'X-Custom: [REDACTED]' x"],
    ["sh -c 'curl -H \"X-Custom: v\" x'", "sh -c 'curl -H \"X-Custom: [REDACTED]\" x'"],
    ["sh -c \"curl -H \\\"X-Custom: v\\\" x\"", "sh -c \"curl -H \\\"X-Custom: [REDACTED]\\\" x\""],
    // The script's own quote is not closed, so it is redacted from that word on.
    ["sh -c \"curl -H \\\"X-Custom: v x\"", "sh -c \"curl -H [REDACTED]\""],
    // A header name takes every RFC 9110 token character, quote marks included.
    ["curl -H \"X'Foo: s3cr3t-value\" x", "curl -H \"X'Foo: [REDACTED]\" x"],
    ["curl -H 'X`Foo: s3cr3t-value' x", "curl -H 'X`Foo: [REDACTED]' x"],
    ["curl -H \"!#$%&'*+-.^_\\`|~Az09: s3cr3t-value\" x", "curl -H \"!#$%&'*+-.^_\\`|~Az09: [REDACTED]\" x"],
    // An unescaped backquote in double quotes runs a command; the shell does
    // not read it as a word, so it is redacted from that word on.
    ["curl -H \"!#$%&'*+-.^_`|~Az09: s3cr3t-value\" x", "curl -H [REDACTED]"],
    ["sh -c \"curl -H \\\"X'Foo: s3cr3t-value\\\" x\"", "sh -c \"curl -H \\\"X'Foo: [REDACTED]\\\" x\""],
    // An unquoted name's quote opens a quoted run the value closes; the
    // redacted value closes it again.
    ["curl -H X'Foo: s3cr3t-value' x", "curl -H X'Foo: [REDACTED]' x"],
    // A quoted part with text glued after it is one shell word, name and value.
    ["curl -H 'X-Foo':s3cr3t-value x", "curl -H 'X-Foo':[REDACTED] x"],
    ["curl -H \"X-Foo\":s3cr3t-value x", "curl -H \"X-Foo\":[REDACTED] x"],
    ["curl -H 'X-Foo: a':s3cr3t-value x", "curl -H 'X-Foo: [REDACTED]' x"],
    ["sh -c \"curl -H 'X-Foo':s3cr3t-value x\"", "sh -c \"curl -H 'X-Foo':[REDACTED] x\""],
    ["sh -c 'curl -H \"X-Foo\":s3cr3t-value x'", "sh -c 'curl -H \"X-Foo\":[REDACTED] x'"],
    ["sh -c 'curl -H X\"Foo: a s3cr3t-value\" x'", "sh -c 'curl -H X\"Foo: [REDACTED]\" x'"],
    ["curl -H 'X-Foo': s3cr3t-value x", "curl -H 'X-Foo': [REDACTED] x"],
    ["curl -H \"X-Foo\": s3cr3t-value x", "curl -H \"X-Foo\": [REDACTED] x"],
    // A header argument that ends at its colon leaves the value in the next word.
    ["curl -H X-Foo: s3cr3t-value https://example.com", "curl -H X-Foo: [REDACTED] https://example.com"],
    ["curl -HX-Foo: s3cr3t-value x", "curl -HX-Foo: [REDACTED] x"],
    ["wget --header=X-Foo: s3cr3t-value x", "wget --header=X-Foo: [REDACTED] x"],
    ["curl -H X-Foo: \"s3cr3t value\" x", "curl -H X-Foo: \"[REDACTED]\" x"],
    ["curl -H X-Foo: s3cr3t'-value x' y", "curl -H X-Foo: [REDACTED] y"],
    ["sh -c 'curl -H X-Foo: s3cr3t-value x'", "sh -c 'curl -H X-Foo: [REDACTED] x'"],
    // Inside a shell's script a rewritten value that opens a quoted run is
    // written before that run's quote.
    ["sh -c \"curl -H X-Foo: \\\"s3cr3t value\\\" x\"", "sh -c \"curl -H X-Foo: [REDACTED] x\""],
    // A flag after it is the next argument, not a value.
    ["curl -H X-Empty: -H 'X-Real: s3cr3t-value' x", "curl -H X-Empty: -H 'X-Real: [REDACTED]' x"],
    ["Bearer tok", "Bearer [REDACTED]"],
    ["curl -H \"X-Api-Key: abc def\" x", "curl -H \"X-Api-Key: [REDACTED]\" x"],
    ["tool --api-key abc --port 8080", "tool --api-key [REDACTED] --port 8080"],
    ["tool --api-key=abc", "tool --api-key=[REDACTED]"],
    ["tool --password \"a b\" next", "tool --password \"[REDACTED]\" next"],
    ["echo '{\"apiKey\": \"abc\", \"n\": 1}'", "echo '{\"apiKey\": \"[REDACTED]\", \"n\": 1}'"],
    ["echo '{\"DATABASE_URL\": \"x\"}'", "echo '{\"DATABASE_URL\": \"[REDACTED]\"}'"],
    ["run sk-abcdefghijklmnop", "run [REDACTED]"],
    ["run ghp_abcdefghijklmnopqrstuvwxyz0123456789", "run [REDACTED]"],
    // A quoted run with a blank in it stays in the URL's shell word.
    ["curl https://h.example.com/'opaque secret' x", "curl https://h.example.com/[REDACTED] x"],
    ["bash -lc 'curl https://h.example.com/\"a b\" x'", "bash -lc 'curl https://h.example.com/[REDACTED] x'"],
    // Every shell escape in a header name is read before the name is matched.
    ["curl -H X\\&Foo: opaque-secret x", "curl -H X\\&Foo: [REDACTED] x"],
    ["curl -H X\\*Foo:opaque-secret x", "curl -H X\\*Foo:[REDACTED] x"],
  ])("redacts %j", (input, expected) => {
    const redacted = redactInventoryText(input)
    expect(redacted).toBe(expected)
    expect(backstopAccepts(redacted)).toBe(true)
  })

  it.each([
    "pnpm build",
    "node /tmp/config=dev/index.js",
    "tool --token-file ./token --max-tokens 10",
    "Bearer [REDACTED]",
    "NODE_ENV=[REDACTED] pnpm build",
    // A URL with no path, or only `/`, keeps it.
    "curl https://example.com",
    "curl https://example.com/",
    "https://example.com:8443/",
    "curl -H @headers.txt x",
    "grep -Hn pattern file",
    // A quoted URL with no path, or only `/`, keeps its quotes.
    "curl 'https://example.com' x",
    "curl \"https://example.com/\"",
    // An empty header with nothing after it, or a quoted one the author closed.
    "curl -H X-Foo:",
    "curl -H X-Foo: ; ls",
    "curl -H \"Host:\" https://example.com",
  ])("keeps %j", (input) => {
    expect(redactInventoryText(input)).toBe(input)
  })

  it("is idempotent", () => {
    const once = redactInventoryText("A=1 curl -u https://u:p@h/?q=1&bare#frag --token t -H 'X-Custom: v' -H 'Authorization: Bearer t'")
    expect(redactInventoryText(once)).toBe(once)
    expect(backstopAccepts(once)).toBe(true)
  })

  it("is idempotent for quote marks in header names", () => {
    const once = redactInventoryText("curl -H \"X'Foo: v\" -H 'X`Bar: v' -H X'Baz: v w' x")
    expect(once).toBe("curl -H \"X'Foo: [REDACTED]\" -H 'X`Bar: [REDACTED]' -H X'Baz: [REDACTED]' x")
    expect(redactInventoryText(once)).toBe(once)
    expect(backstopAccepts(once)).toBe(true)
  })

  it("is idempotent for a header value split from its header", () => {
    const once = redactInventoryText("curl -H X-Qux: v -H X-Quux: \"v w\" x")
    expect(once).toBe("curl -H X-Qux: [REDACTED] -H X-Quux: \"[REDACTED]\" x")
    expect(redactInventoryText(once)).toBe(once)
    expect(backstopAccepts(once)).toBe(true)
  })

  it("is idempotent for a redacted URL path", () => {
    const once = redactInventoryText("curl https://u:p@h.example.com:8443/a/b?k=v&bare#f")
    // The `?` and the `&` read into the URL are quoted, so the word reads back
    // as one word and expands to nothing else.
    expect(once).toBe("curl https://[REDACTED]@h.example.com:8443/[REDACTED]'?k=[REDACTED]&[REDACTED]#[REDACTED]'")
    expect(redactInventoryText(once)).toBe(once)
    expect(backstopAccepts(once)).toBe(true)
  })

  it("is idempotent for escaped and unreadable header names", () => {
    const once = redactInventoryText("curl -H \"X\\`Foo: v\" -H X\\`Bar:v -H \"X Baz: v\" -H 'X(Qux): v' x")
    expect(once).toBe("curl -H \"X\\`Foo: [REDACTED]\" -H X\\`Bar:[REDACTED] -H \"[REDACTED]\" -H '[REDACTED]' x")
    expect(redactInventoryText(once)).toBe(once)
    expect(backstopAccepts(once)).toBe(true)
  })

  it("is idempotent for a URL path with quoted runs", () => {
    const once = redactInventoryText("curl https://h/'a'\"b\"/c 'https://h/'s \"https://h/\"'s'?k=v sh -c \"curl https://h/'s' x\"")
    expect(once).toBe("curl https://h/[REDACTED] 'https://h/[REDACTED]' \"https://h/[REDACTED]?k=[REDACTED]\" sh -c \"curl https://h/[REDACTED] x\"")
    expect(redactInventoryText(once)).toBe(once)
    expect(backstopAccepts(once)).toBe(true)
  })

  it("is idempotent for a quoted header name with its value glued on", () => {
    const once = redactInventoryText("curl -H 'X-Foo':v -H \"X-Bar\":v -H 'X-Baz: a':v x")
    expect(once).toBe("curl -H 'X-Foo':[REDACTED] -H \"X-Bar\":[REDACTED] -H 'X-Baz: [REDACTED]' x")
    expect(redactInventoryText(once)).toBe(once)
    expect(backstopAccepts(once)).toBe(true)
  })
})

describe("redactInventoryArgv", () => {
  it("redacts sensitive flag values, assignments and user info per argument", () => {
    const command = redactInventoryArgv([
      "npx", "server", "--api-key", "abc", "DATABASE_URL=postgres://u:p@h/db", "--url", "https://t@h/x", "env", "PASSWORD=correct horse",
    ])
    expect(command).toBe("npx server --api-key [REDACTED] DATABASE_URL=[REDACTED] --url https://[REDACTED]@h/[REDACTED] env PASSWORD=[REDACTED]")
    expect(backstopAccepts(command)).toBe(true)
  })

  it("redacts header values and bare query and fragment parts per argument", () => {
    const command = redactInventoryArgv([
      "curl", "-H", "X-Custom: opaque-header-secret", "--header=X-Other: v2", "-HX-Third: v3", "--proxy-header", "X-Proxy: v4",
      "https://example.com/cb?bare-query-secret#opaque-fragment-secret",
    ])
    expect(command).toBe(
      "curl -H 'X-Custom: [REDACTED]' '--header=X-Other: [REDACTED]' '-HX-Third: [REDACTED]' --proxy-header 'X-Proxy: [REDACTED]' 'https://example.com/[REDACTED]?[REDACTED]#[REDACTED]'",
    )
    expect(backstopAccepts(command)).toBe(true)
  })

  // A backquote is shell text a hook would pass on, so it is redacted from
  // its argument on.
  it("redacts header values whose names hold quote marks", () => {
    const command = redactInventoryArgv(["curl", "-H", "X'Foo: s3cr3t-value", "--header=X`Bar: hunter2", "-HX'Baz: tok-abc"])
    expect(command).toBe("curl -H 'X'\"'\"'Foo: [REDACTED]' [REDACTED]")
    expect(backstopAccepts(command)).toBe(true)
  })

  it("redacts the next argument after a header that ends at its colon", () => {
    const command = redactInventoryArgv([
      "curl", "-H", "X-Foo:", "s3cr3t-value", "-HX-Bar:", "hunter2", "--header=X-Baz:", "tok abc", "-H", "X-Empty:", "-H", "X-Real: q-secret", "x",
    ])
    expect(command).toBe("curl -H X-Foo: [REDACTED] -HX-Bar: [REDACTED] --header=X-Baz: [REDACTED] -H X-Empty: -H 'X-Real: [REDACTED]' x")
    expect(backstopAccepts(command)).toBe(true)
  })

  it("redacts a URL's whole path and keeps a bare host", () => {
    const command = redactInventoryArgv([
      "curl", "https://hooks.example.com/services/T0/B0/XXXX", "--url", "https://example.com/", "https://example.com", "https://h.example.com/a?key=v#f",
    ])
    expect(command).toBe("curl https://hooks.example.com/[REDACTED] --url https://example.com/ https://example.com 'https://h.example.com/[REDACTED]?key=[REDACTED]#[REDACTED]'")
    expect(backstopAccepts(command)).toBe(true)
  })

  it("redacts a quoted header name with its value glued on", () => {
    const command = redactInventoryArgv(["curl", "-H", "'X-Foo':s3cr3t-value", "-H", "\"X-Bar\":hunter2", "--header='X-Baz':tok-abc"])
    expect(command).toBe("curl -H ''\"'\"'X-Foo'\"'\"':[REDACTED]' -H '\"X-Bar\":[REDACTED]' '--header='\"'\"'X-Baz'\"'\"':[REDACTED]'")
    expect(backstopAccepts(command)).toBe(true)
    const shell = redactInventoryArgv(["sh", "-c", "curl -H 'X-Foo':s3cr3t-value x"])
    expect(shell).toBe("sh -c 'curl -H '\"'\"'X-Foo'\"'\"':[REDACTED] x'")
    expect(backstopAccepts(shell)).toBe(true)
  })

  // A header argument that does not read as a header is redacted whole; a
  // backquote is shell text a hook would pass on, redacted from its argument on.
  it("redacts a header argument that does not read as a header", () => {
    const command = redactInventoryArgv(["curl", "-H", "X Foo: hunter2", "--header=X(Foo): tok-abc", "-H", "@headers.txt", "-H", "X`Foo: opaque-secret", "x"])
    expect(command).toBe("curl -H [REDACTED] --header=[REDACTED] -H @headers.txt -H [REDACTED]")
    expect(backstopAccepts(command)).toBe(true)
  })

  it("redacts a URL path that holds quote marks", () => {
    const command = redactInventoryArgv(["curl", "https://hooks.example.com/'opaque-secret'", "https://h.example.com/a\"b\"c"])
    expect(command).toBe("curl https://hooks.example.com/[REDACTED] https://h.example.com/[REDACTED]")
    expect(backstopAccepts(command)).toBe(true)
  })

  it("quotes an argument that holds spaces", () => {
    expect(redactInventoryArgv(["sh", "-c", "echo hi"])).toBe("sh -c 'echo hi'")
  })

  it("redacts a URL path with a blank and a header named with a shell metacharacter", () => {
    const command = redactInventoryArgv(["curl", "https://h.example.com/opaque secret", "-H", "X&Foo:", "hunter2", "-H", "X*Bar: tok-abc"])
    expect(command).toBe("curl https://h.example.com/[REDACTED] -H 'X&Foo:' [REDACTED] -H 'X*Bar: [REDACTED]'")
    expect(backstopAccepts(command)).toBe(true)
  })
})

// Text the shell cannot be read as words is redacted from the word where
// reading stopped to the end.
describe("redactInventoryText when the text does not read as shell words", () => {
  it.each([
    ["curl -H \"X-Foo: s3cr3t value", "curl -H [REDACTED]"],
    ["curl -H 'X-Foo: s3cr3t value", "curl -H [REDACTED]"],
    ["echo $(cat token) x", "echo [REDACTED]"],
    ["echo `cat token` x", "echo [REDACTED]"],
    ["cat <<EOF", "cat [REDACTED]"],
    ["sh -c 'curl -H \"X-Foo: s3cr3t value'", "sh -c 'curl -H [REDACTED]'"],
  ])("redacts %j", (input, expected) => {
    const redacted = redactInventoryText(input)
    expect(redacted).toBe(expected)
    expect(redactInventoryText(redacted)).toBe(redacted)
    expect(backstopAccepts(redacted)).toBe(true)
  })
})

// One value, `alpha9 omega7`, spelled in the ways a shell joins into one word,
// in the places a URL path, query, user info or header value can take it.
describe("shell words around a URL path and a header value", () => {
  const spellings = [
    "'alpha9 omega7'", "\"alpha9 omega7\"", "alpha9\\ omega7", "alpha9' 'omega7", "\"alpha9\"' omega7'", "'alpha9'\\ \"omega7\"",
    "alpha9'\\ 'omega7", "\"alpha9\\\" omega7\"", "alpha9\"\\$ \"omega7", "'alpha9'omega7", "alpha9\"omega7\"", "alpha9\\omega7",
    "\"alpha9\\`omega7\"", "alpha9\\\"' omega7'",
  ]
  const tokenCharacters = [..."!#$%&'*+.^_`|~-"]
  const commands = (word: string) => [
    `curl https://h.example.com/${word} x`,
    `curl 'https://h.example.com/'${word} x`,
    `curl "https://h.example.com/a"${word} x`,
    `curl "https://h.example.com/p?k="${word} x`,
    `curl https://h.example.com/p?${word} x`,
    `curl https://h.example.com/#${word} x`,
    `curl https://${word}@h.example.com x`,
    `curl -H X-Foo:${word} x`,
    `curl -H X-Foo: ${word} x`,
    `curl -H 'X-Foo: '${word} x`,
    `curl -H "X-Foo":${word} x`,
    `curl --header=X-Foo:${word} x`,
    `curl -HX-Foo: ${word} x`,
    `curl -H 'Authorization: Bearer '${word} x`,
    `tool --token ${word} x`,
    `API_KEY=${word} tool`,
    ...tokenCharacters.map((character) => `curl -H X\\${character}Foo: ${word} x`),
    ...tokenCharacters.map((character) => `curl -H X\\${character}Foo:${word} x`),
  ]
  const singleQuoted = (text: string) => `'${text.replace(/'/gu, "'\\''")}'`
  const doubleQuoted = (text: string) => `"${text.replace(/[\\"$`]/gu, "\\$&")}"`
  const cases = spellings.flatMap((word) => commands(word).flatMap((command) => [
    command, `sh -c ${singleQuoted(command)}`, `bash -lc ${doubleQuoted(command)}`, `zsh -c ${singleQuoted(`sh -c ${doubleQuoted(command)}`)}`,
  ]))

  it.each(cases)("never emits the value of %j", (input) => {
    const redacted = redactInventoryText(input)
    expect(redacted).not.toMatch(/alpha9|omega7/u)
    expect(redactInventoryText(redacted)).toBe(redacted)
    expect(backstopAccepts(redacted)).toBe(true)
  })

  it.each(cases)("never emits the value of %j given as an argument vector", (input) => {
    const redacted = redactInventoryArgv(["sh", "-c", input])
    expect(redacted).not.toMatch(/alpha9|omega7/u)
    expect(backstopAccepts(redacted)).toBe(true)
  })

  it.each([
    ["curl", "https://h.example.com/alpha9 omega7"],
    ["curl", "-H", "X&Foo:", "alpha9 omega7"],
    ["curl", "-H", "X&Foo: alpha9 omega7"],
    ["curl", "--header=X`Foo: alpha9 omega7"],
    ["curl", "https://h.example.com/p?alpha9 omega7#alpha9 omega7"],
  ])("never emits the value in the argument vector %j", (...argv) => {
    const redacted = redactInventoryArgv(argv)
    expect(redacted).not.toMatch(/alpha9|omega7/u)
    expect(backstopAccepts(redacted)).toBe(true)
  })
})

// Shell text that runs a command or expands a parameter with an operand is
// not read as words, so it is redacted from its word on; an operator escaped
// or quoted inside a URL or header word stays inside that word when the word
// is written again.
describe("shell text that runs, expands or escapes an operator", () => {
  it.each([
    ["curl -H X-Foo: <(printf opaque-secret) x", "curl -H X-Foo: [REDACTED]"],
    ["curl -H X-Foo: >(printf opaque-secret) x", "curl -H X-Foo: [REDACTED]"],
    ["cat x<(printf opaque-secret) y", "cat x [REDACTED]"],
    ["diff =(printf opaque-secret) x", "diff [REDACTED]"],
    ["run API_KEY=(opaque-secret) x", "run [REDACTED]"],
    ["echo ${TOKEN-opaque-secret} x", "echo [REDACTED]"],
    ["echo ${TOKEN+opaque-secret} x", "echo [REDACTED]"],
    ["echo ${TOKEN?opaque-secret} x", "echo [REDACTED]"],
    ["echo \"${TOKEN:-opaque-secret}\" x", "echo [REDACTED]"],
    ["sh -c 'curl -H X-Foo: <(printf opaque-secret) x'", "sh -c 'curl -H X-Foo: [REDACTED]'"],
    ["sh -c 'echo ${TOKEN-opaque-secret} x'", "sh -c 'echo [REDACTED]'"],
    ["curl https://h.example.com/p?a=one\\&b=two", "curl https://h.example.com/[REDACTED]'?a=[REDACTED]&b=[REDACTED]'"],
    ["curl https://h.example.com/p?a=one\\;b=two x", "curl https://h.example.com/[REDACTED]'?a=[REDACTED];b=[REDACTED]' x"],
  ])("redacts %j", (input, expected) => {
    const redacted = redactInventoryText(input)
    expect(redacted).toBe(expected)
    expect(redactInventoryText(redacted)).toBe(redacted)
    expect(backstopAccepts(redacted)).toBe(true)
  })

  it.each([
    "echo ${HOME} x",
    "echo \"${HOME}/bin\" ${1} ${@}",
  ])("keeps %j", (input) => {
    expect(redactInventoryText(input)).toBe(input)
  })

  const parameterForms = [
    "${TOKEN-opaque-secret}", "${TOKEN:-opaque-secret}", "${TOKEN+opaque-secret}", "${TOKEN:+opaque-secret}",
    "${TOKEN?opaque-secret}", "${TOKEN:?opaque-secret}", "${TOKEN=opaque-secret}", "${TOKEN:=opaque-secret}",
    "${TOKEN#opaque-secret}", "${TOKEN##opaque-secret}", "${TOKEN%opaque-secret}", "${TOKEN%%opaque-secret}",
    "${TOKEN/x/opaque-secret}", "${TOKEN//x/opaque-secret}", "${TOKEN^opaque-secret}", "${TOKEN^^opaque-secret}",
    "${TOKEN,opaque-secret}", "${TOKEN,,opaque-secret}", "${TOKEN:1:opaque-secret}", "${TOKEN@opaque-secret}",
    "${#opaque-secret}", "${!opaque-secret}",
  ]
  // Shapes the shell does not read as words: redacted from their word on.
  const unreadable = [
    "curl -H X-Foo: <(printf opaque-secret) x",
    "curl -H X-Foo: >(printf opaque-secret) x",
    "cat x<(printf opaque-secret) y",
    "cat x>(printf opaque-secret) y",
    "diff =(printf opaque-secret) x",
    "run API_KEY=(opaque-secret) x",
    "echo $(printf opaque-secret) x",
    "echo `printf opaque-secret` x",
    ...parameterForms.map((form) => `echo ${form} x`),
    ...parameterForms.map((form) => `echo "${form}" x`),
    ...parameterForms.map((form) => `echo a${form}b x`),
    // Operators written unquoted after a URL are read into it.
    "curl https://h.example.com/p?a=1&b=opaque-secret",
    "curl https://h.example.com/p?a=1;opaque-secret|x",
  ]
  // One word with an escaped or quoted operator in it: it stays one word.
  const escaped = [
    "curl https://h.example.com/p?a=one\\&b=opaque-secret x",
    "curl https://h.example.com/p?a=opaque-secret\\;b=two x",
    "curl https://h.example.com/p?a=opaque-secret\\|b=two x",
    "curl https://h.example.com/p\\&opaque-secret x",
    "curl https://h.example.com/p\\;opaque-secret\\|x y",
    "curl https://h.example.com/#a\\&opaque-secret x",
    "curl https://h.example.com/p?k=opaque-secret\\>x\\<y x",
    "curl https://h.example.com/a\\ b?k=opaque-secret x",
    "curl https://h.example.com/p?a='1&b'=opaque-secret x",
    "curl https://h.example.com/p?a=\"1;b|c\"=opaque-secret x",
    "curl 'https://h.example.com/p?a=1&b=opaque-secret;c|d' x",
    "curl \"https://h.example.com/p?a=1&b=opaque-secret\" x",
    "curl -H X-Foo:opaque-secret\\&b x",
    "curl -H X-Foo:opaque-secret\\;b x",
    "curl -H X-Foo:opaque-secret\\|b x",
    "curl -H X\\&Foo: opaque-secret\\;x y",
    "curl -H X\\|Foo:opaque-secret\\&x y",
    "curl -H X\\&Foo\\;: opaque-secret y",
    "curl -H 'X-Foo: opaque-secret; b|c&d' x",
    "curl -H X-Foo: opaque-secret\\&\\;\\| y",
  ]
  const singleQuoted = (text: string) => `'${text.replace(/'/gu, "'\\''")}'`
  const doubleQuoted = (text: string) => `"${text.replace(/[\\"$`]/gu, "\\$&")}"`
  const wrapped = (command: string) => [command, `sh -c ${singleQuoted(command)}`, `bash -lc ${doubleQuoted(command)}`]

  it.each(unreadable.flatMap(wrapped))("never emits the value of %j", (input) => {
    const redacted = redactInventoryText(input)
    expect(redacted).not.toMatch(/opaque-secret/u)
    expect(redactInventoryText(redacted)).toBe(redacted)
    expect(backstopAccepts(redacted)).toBe(true)
    expect(inventoryShellWords(redacted)).toBeDefined()
  })

  it.each(escaped.flatMap(wrapped))("never emits the value of %j and keeps its words", (input) => {
    const redacted = redactInventoryText(input)
    expect(redacted).not.toMatch(/opaque-secret/u)
    expect(redactInventoryText(redacted)).toBe(redacted)
    expect(backstopAccepts(redacted)).toBe(true)
    expect(inventoryShellWords(redacted)).toHaveLength(inventoryShellWords(input)!.length)
  })

  it.each(escaped)("keeps the words of the script in %j", (input) => {
    const script = inventoryShellWords(redactInventoryText(`sh -c ${singleQuoted(input)}`))![2]!
    expect(inventoryShellWords(script)).toHaveLength(inventoryShellWords(input)!.length)
  })

  it.each([
    [["curl", "$(printf opaque-secret)"], "curl [REDACTED]"],
    [["cmd", "x", "`printf opaque-secret`", "y"], "cmd x [REDACTED]"],
    [["cmd", "<(printf opaque-secret)", "y"], "cmd [REDACTED]"],
    [["cmd", "a>(printf opaque-secret)"], "cmd [REDACTED]"],
    [["cmd", "=(printf opaque-secret)"], "cmd [REDACTED]"],
    [["cmd", "--opt=${TOKEN:-opaque-secret}", "y"], "cmd [REDACTED]"],
    [["sh", "-c", "curl -H X-Foo: <(printf opaque-secret) x"], "sh -c 'curl -H X-Foo: [REDACTED]'"],
    [["curl", "https://h.example.com/p?a=one&b=two"], "curl 'https://h.example.com/[REDACTED]?a=[REDACTED]&b=[REDACTED]'"],
  ])("redacts the argument vector %j", (argv, expected) => {
    const redacted = redactInventoryArgv(argv)
    expect(redacted).toBe(expected)
    expect(backstopAccepts(redacted)).toBe(true)
  })

  it.each([
    ...unreadable.map((command) => ["sh", "-c", command]),
    ...escaped.map((command) => ["sh", "-c", command]),
    ...parameterForms.map((form) => ["cmd", form, "x"]),
    ["cmd", "$(printf opaque-secret)", "x"],
    ["cmd", "x`printf opaque-secret`", "x"],
    ["cmd", "<(printf opaque-secret)", "x"],
    ["cmd", ">(printf opaque-secret)", "x"],
    ["curl", "-H", "X-Foo;Bar: opaque-secret"],
    ["curl", "https://h.example.com/p?a=1&b=opaque-secret|c;d"],
  ])("never emits the value in the argument vector %j", (...argv) => {
    const redacted = redactInventoryArgv(argv)
    expect(redacted).not.toMatch(/opaque-secret/u)
    expect(backstopAccepts(redacted)).toBe(true)
    expect(inventoryShellWords(redacted)).toBeDefined()
  })

  // An argument the rules leave alone reads back as itself, so no shown
  // argument runs, expands or splits.
  it("quotes every argument the shell reads specially", () => {
    const argv = [
      "echo", "a;b", "x|y", "p&q", "$HOME", "${HOME}", "a\\b", "say \"hi\"", "it's", "a b", "<in", ">out", "(x)", "#c", "~u", "{a,b}", "*", "", "tab\there", "line\nbreak",
    ]
    const command = redactInventoryArgv(argv)
    // The protocol refuses control characters in any text, a tab included, so
    // an argument that holds one is shown as the marker.
    expect(inventoryShellWords(command)).toEqual(argv.map((word) => (/[\t\n]/u.test(word) ? "[REDACTED]" : word)))
    expect(backstopAccepts(command)).toBe(true)
    expect(backstopAccepts(redactInventoryArgv(argv.filter((word) => !/[\t\n]/u.test(word))))).toBe(true)
  })
})

// `$'...'` and `$"..."` are not POSIX quoting: an argument that holds one is
// shell text the reader does not read, redacted from that argument on.
describe("redactInventoryArgv with ANSI C and localized quoting", () => {
  it.each([
    [["cmd", "$'opaque-secret'", "tail"], "cmd [REDACTED]"],
    [["cmd", "$\"opaque-secret\"", "tail"], "cmd [REDACTED]"],
    [["cmd", "x", "--opt=a$'\\x6fpaque-secret'", "y"], "cmd x [REDACTED]"],
    [["cmd", "x", "a$\"opaque-secret\"b", "y"], "cmd x [REDACTED]"],
  ])("redacts the argument vector %j", (argv, expected) => {
    const redacted = redactInventoryArgv(argv)
    expect(redacted).toBe(expected)
    expect(redacted).not.toMatch(/opaque-secret/u)
    expect(backstopAccepts(redacted)).toBe(true)
    expect(inventoryShellWords(redacted)).toEqual(inventoryShellWords(expected))
  })
})

// Pathname patterns (`*`, `?`, `[`) and brace expansion (`{a,b}`, `{1..3}`)
// turn one word into several or none, and the reader does not model them. An
// emitted word never holds one unquoted: text keeps its source with each such
// character escaped, and an argument holding one is quoted.
describe("pattern and brace characters in emitted words", () => {
  const textCases: ReadonlyArray<[string, string]> = [
    ["echo {a,b}", "echo \\{a,b}"],
    ["echo {1..3} x", "echo \\{1..3} x"],
    ["ls a?b", "ls a\\?b"],
    ["ls a[bc]", "ls a\\[bc]"],
    ["ls *.ts x", "ls \\*.ts x"],
    ["ls \"$HOME\"/*.ts", "ls \"$HOME\"/\\*.ts"],
    ["sh -c 'ls a?b'", "sh -c 'ls a\\?b'"],
    ["bash -lc \"ls a?b *\"", "bash -lc \"ls a\\\\?b \\\\*\""],
    ["curl -H X*Foo:opaque-secret x", "curl -H X\\*Foo:[REDACTED] x"],
    ["curl -H X*Foo: opaque-secret a?b", "curl -H X\\*Foo: [REDACTED] a\\?b"],
    ["tool --token opaque-secret a?b", "tool --token [REDACTED] a\\?b"],
  ]

  it.each(textCases)("writes %j so no pattern expands", (input, expected) => {
    const redacted = redactInventoryText(input)
    expect(redacted).toBe(expected)
    expect(redacted).not.toMatch(/opaque-secret/u)
    expect(redactInventoryText(redacted)).toBe(redacted)
    expect(backstopAccepts(redacted)).toBe(true)
    expect(inventoryShellWords(redacted)).toEqual(inventoryShellWords(input)!.map((word) => word.replace("opaque-secret", "[REDACTED]")))
  })

  // A `[` or `[[` word is the test command, `$?` and `$*` are parameters, and
  // `{}` or `{a}` is not a brace expansion; quoted and escaped forms are
  // already literal.
  it.each([
    "[ -f x ] && echo $? $*",
    "[[ -n x ]]",
    "find . -exec rm {} +",
    "echo {a} '{a,b}' \"a?b\" a\\*b \\[x]",
    "echo [REDACTED]",
  ])("keeps %j", (input) => {
    expect(redactInventoryText(input)).toBe(input)
  })

  const argvCases: ReadonlyArray<[string[], string]> = [
    [["cmd", "a?b"], "cmd 'a?b'"],
    [["cmd", "a[bc]"], "cmd 'a[bc]'"],
    [["cmd", "x*", "{a,b}", "[", "a]"], "cmd 'x*' '{a,b}' '[' a]"],
    [["cmd", "--token", "opaque-secret", "a?b"], "cmd --token [REDACTED] 'a?b'"],
  ]

  it.each(argvCases)("quotes the argument vector %j", (argv, expected) => {
    const redacted = redactInventoryArgv(argv)
    expect(redacted).toBe(expected)
    expect(backstopAccepts(redacted)).toBe(true)
    expect(inventoryShellWords(redacted)).toEqual(argv.map((word) => (word === "opaque-secret" ? "[REDACTED]" : word)))
  })

  // The same outputs read by real shells, in a directory where each pattern
  // would match: they see the words the reader does.
  describe.skipIf(process.platform === "win32")("read by a shell", () => {
    let directory = ""
    beforeAll(() => {
      directory = mkdtempSync(join(tmpdir(), "domovoi-inventory-words-"))
      for (const name of ["acb", "adb", "ab", "x.ts", "y.ts", "xa", "a"]) writeFileSync(join(directory, name), "")
    })
    afterAll(() => rmSync(directory, { recursive: true, force: true }))

    const shells = ["/bin/sh", "/bin/bash"].filter((shell) => existsSync(shell))
    const read = (shell: string, command: string) => execFileSync(shell, ["-c", `set -- ${command}; printf '%s\\0' "$@"`], {
      cwd: directory, encoding: "utf8", env: { PATH: "/usr/bin:/bin" },
    }).split("\0").slice(0, -1)
    const outputs = [
      ...textCases.filter(([input]) => !/\$|sh -c|-lc/u.test(input)).map(([input]) => redactInventoryText(input)),
      ...argvCases.map(([argv]) => redactInventoryArgv(argv)),
      redactInventoryText("curl https://example.com/?q=1"),
      redactInventoryArgv(["curl", "https://h.example.com/a?key=v#f"]),
    ]

    it.each(shells.flatMap((shell) => outputs.map((output) => [shell, output])))("%s reads %j as the reader does", (shell, output) => {
      expect(read(shell, output)).toEqual(inventoryShellWords(output))
    })
  })
})

// The protocol refuses control and format characters in any text. A word or
// text that would carry one is redacted from there on, so the entry is still
// listed rather than dropped.
describe("control characters in emitted text", () => {
  // A format character, which the protocol refuses as it does a control one.
  const rightToLeftOverride = String.fromCodePoint(0x202e)

  it.each([
    ["curl -H X-Foo: \\\nopaque-secret tail", "curl -H X-Foo: [REDACTED]"],
    ["npm test\nnpm run lint", "npm test [REDACTED]"],
    ["npm test\n", "npm test [REDACTED]"],
    ["\nnpm test", "[REDACTED]"],
    ["line one\nline two", "line one [REDACTED]"],
    ["echo 'a\tb' x", "echo [REDACTED]"],
    ["echo a\tb", "echo a [REDACTED]"],
    ["echo a\\\nb x", "echo [REDACTED]"],
    [`echo "a${rightToLeftOverride}b" x`, "echo [REDACTED]"],
    ["sh -c 'npm test\nnpm run lint'", "sh -c 'npm test [REDACTED]'"],
    ["sh -c \"TOKEN=a\tb\"", "sh -c \"TOKEN=[REDACTED]\""],
  ])("redacts %j", (input, expected) => {
    const redacted = redactInventoryText(input)
    expect(redacted).toBe(expected)
    expect(redacted).not.toMatch(/opaque-secret/u)
    expect(redactInventoryText(redacted)).toBe(redacted)
    expect(backstopAccepts(redacted)).toBe(true)
    expect(inventoryShellWords(redacted)).toBeDefined()
  })

  it.each([
    [["cmd", "line\nbreak", "x"], "cmd [REDACTED] x"],
    [["cmd", "tab\there", "x"], "cmd [REDACTED] x"],
    [["cmd", `a${rightToLeftOverride}b`], "cmd [REDACTED]"],
    [["sh", "-c", "npm test\nnpm run lint"], "sh -c 'npm test [REDACTED]'"],
  ])("redacts the argument vector %j", (argv, expected) => {
    const redacted = redactInventoryArgv(argv)
    expect(redacted).toBe(expected)
    expect(backstopAccepts(redacted)).toBe(true)
    expect(inventoryShellWords(redacted)).toBeDefined()
  })
})
