import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { toolInventoryEntrySchema } from "@getdomovoi/protocol"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { inventoryFieldCaps, inventoryShellWords, redactInventoryArgv, redactInventoryCommand, redactInventoryText } from "./inventory-redaction.js"
import {
  hiddenTriggerCredential, hiddenTriggerPlacements, hiddenTriggerWords, sameWordCases, sameWordCredentials, sameWordPlacements, sameWordWrappers,
} from "./test-hidden-triggers.js"
import { adversarialCommands, nearLinearGrowth, quadraticTimeGrowth, regexAdversaries, timeGrowth, workGrowth } from "./test-work.js"

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
    ["curl https://example.com/?q=1", "curl https://example.com/?q=[REDACTED]"],
    ["https://example.com/path", "https://example.com/[REDACTED]"],
    ["https://example.com/p?a=", "https://example.com/[REDACTED]?a="],
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
    // A quote escaped right after the marker is single-quoted instead.
    ["sh -c \"curl -H \\\"X-Custom: v\\\" x\"", "sh -c \"curl -H \\\"X-Custom: [REDACTED]\"'\"'\" x\""],
    // The script's own quote is not closed, so it is redacted from that word on.
    ["sh -c \"curl -H \\\"X-Custom: v x\"", "sh -c \"curl -H [REDACTED]\""],
    // A header name takes every RFC 9110 token character, quote marks included.
    ["curl -H \"X'Foo: s3cr3t-value\" x", "curl -H \"X'Foo: [REDACTED]\" x"],
    ["curl -H 'X`Foo: s3cr3t-value' x", "curl -H 'X`Foo: [REDACTED]' x"],
    ["curl -H \"!#$%&'*+-.^_\\`|~Az09: s3cr3t-value\" x", "curl -H \"!#$%&'*+-.^_\\`|~Az09: [REDACTED]\" x"],
    // An unescaped backquote in double quotes runs a command; the shell does
    // not read it as a word, so it is redacted from that word on.
    ["curl -H \"!#$%&'*+-.^_`|~Az09: s3cr3t-value\" x", "curl -H [REDACTED]"],
    ["sh -c \"curl -H \\\"X'Foo: s3cr3t-value\\\" x\"", "sh -c \"curl -H \\\"X'Foo: [REDACTED]\"'\"'\" x\""],
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
    // A scheme word starts wherever the protocol backstop reads one, after a
    // `/` too, and the backstop refuses the text with its value shown.
    ["tool --token-file ./token --max-tokens 10", "tool --token-file ./token [REDACTED] 10"],
    ["cat ./Token swordfish tail", "cat ./Token [REDACTED] tail"],
  ])("redacts %j", (input, expected) => {
    const redacted = redactInventoryText(input)
    expect(redacted).toBe(expected)
    expect(backstopAccepts(redacted)).toBe(true)
  })

  it.each([
    "pnpm build",
    "node /tmp/config=dev/index.js",
    "tool --token-file ./secrets --max-tokens 10",
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
    // The `&` read into the URL is quoted, so the word reads back as one word.
    expect(once).toBe("curl https://[REDACTED]@h.example.com:8443/[REDACTED]?k=[REDACTED]'&[REDACTED]#[REDACTED]'")
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

// A flag after a scheme word is read for its own value, and then hidden
// whole: the protocol backstop takes any word after a scheme as its
// credential, a flag too, and would refuse the entry.
describe("a scheme word before a sensitive flag", () => {
  const texts: ReadonlyArray<[string, string]> = [
    ["curl Bearer --token s3cr3t-value", "curl Bearer [REDACTED] [REDACTED]"],
    ["curl Bearer --token=s3cr3t-value", "curl Bearer [REDACTED]"],
    ["curl Token --api-key hunter2 x", "curl Token [REDACTED] [REDACTED] x"],
    ["curl Bearer -H 'X-Foo: s3cr3t-value' x", "curl Bearer [REDACTED] 'X-Foo: [REDACTED]' x"],
    ["curl Bearer --verbose x", "curl Bearer [REDACTED] x"],
    ["curl Token Token s3cr3t-value", "curl Token Token [REDACTED]"],
    // A scheme word taken as another rule's value is still read as a scheme.
    ["curl Bearer --token Token s3cr3t-value", "curl Bearer [REDACTED] [REDACTED] [REDACTED]"],
    ["curl Bearer Basic s3cr3t-value", "curl Bearer [REDACTED] [REDACTED]"],
    ["curl --token Bearer s3cr3t-value", "curl --token [REDACTED] [REDACTED]"],
    ["curl Token --api-key Digest s3cr3t-value x", "curl Token [REDACTED] [REDACTED] [REDACTED] x"],
    ["curl -H 'X-Foo: Bearer' s3cr3t-value", "curl -H 'X-Foo: [REDACTED]' [REDACTED]"],
    ["tool --password Token s3cr3t-value", "tool --password [REDACTED] [REDACTED]"],
  ]

  it.each(texts)("redacts the flag's value in %s", (input, expected) => {
    for (const redact of [redactInventoryText, redactInventoryCommand]) {
      const redacted = redact(input)
      expect(redacted).toBe(expected)
      expect(backstopAccepts(redacted)).toBe(true)
      expect(redact(redacted)).toBe(redacted)
    }
  })

  it("redacts the flag's value in an argument vector", () => {
    const command = redactInventoryArgv(["curl", "Bearer", "--token", "s3cr3t-value", "Basic", "--password=hunter2"])
    expect(command).toBe("curl Bearer [REDACTED] [REDACTED] Basic [REDACTED]")
    expect(backstopAccepts(command)).toBe(true)
  })

  it.each([
    [["curl", "Bearer", "--token", "Token", "s3cr3t-value"], "curl Bearer [REDACTED] [REDACTED] [REDACTED]"],
    [["curl", "Bearer", "Basic", "s3cr3t-value"], "curl Bearer [REDACTED] [REDACTED]"],
    [["curl", "--token", "Bearer", "s3cr3t-value"], "curl --token [REDACTED] [REDACTED]"],
    [["curl", "-H", "X-Foo: Bearer", "s3cr3t-value"], "curl -H 'X-Foo: [REDACTED]' [REDACTED]"],
  ])("redacts a scheme word taken as a value in the argument vector %j", (argv, expected) => {
    const command = redactInventoryArgv(argv)
    expect(command).toBe(expected)
    expect(backstopAccepts(command)).toBe(true)
  })

  // Every chain of up to three scheme and flag words before a value: the
  // value of a last scheme word or sensitive flag is never shown, and every
  // output is accepted and reads the same when redacted again.
  const vocabulary = ["Bearer", "Basic", "Token", "Digest", "--token", "--api-key", "--verbose", "-H"]
  const chains: string[][] = [[]]
  for (let length = 1; length <= 3; length += 1) {
    for (const chain of chains.filter((item) => item.length === length - 1)) chains.push(...vocabulary.map((word) => [...chain, word]))
  }
  const hidesValue = (chain: readonly string[]) => ["Bearer", "Basic", "Token", "Digest", "--token", "--api-key"].includes(chain.at(-1) ?? "")

  it.each(chains.filter((chain) => chain.length > 0).map((chain) => [chain.join(" ")]))("redacts the chain %s before a value", (chain) => {
    const words = chain.split(" ")
    const input = `curl ${chain} s3cr3t-value x`
    for (const redact of [redactInventoryText, redactInventoryCommand]) {
      const redacted = redact(input)
      if (hidesValue(words)) expect(redacted).not.toContain("s3cr3t-value")
      expect(backstopAccepts(redacted)).toBe(true)
      expect(redact(redacted)).toBe(redacted)
    }
    const command = redactInventoryArgv(["curl", ...words, "s3cr3t-value", "x"])
    if (hidesValue(words)) expect(command).not.toContain("s3cr3t-value")
    expect(backstopAccepts(command)).toBe(true)
  })
})

// A word that names the next word's value is read wherever it sits in the
// original words, whichever rule hid or read past the value it ends: the
// value after it is hidden too, and the output is not refused.
describe("a scheme word or sensitive flag inside a value another rule took", () => {
  it.each([
    ["curl --token 'https://host/ Token' s3cr3t-value", "curl --token '[REDACTED]' [REDACTED]", ["curl", "--token", "https://host/ Token", "s3cr3t-value"], "curl --token [REDACTED] [REDACTED]"],
    ["curl --token 'x -H X-Foo: Bearer ' s3cr3t-value", "curl --token '[REDACTED]' [REDACTED]", ["curl", "--token", "x -H X-Foo: Bearer ", "s3cr3t-value"], "curl --token [REDACTED] [REDACTED]"],
    ["curl 'https://host/ --token' s3cr3t-value", "curl 'https://host/[REDACTED]' [REDACTED]", ["curl", "https://host/ --token", "s3cr3t-value"], "curl https://host/[REDACTED] [REDACTED]"],
    ["sh -c 'curl Bearer' s3cr3t-value", "sh -c 'curl Bearer' [REDACTED]", ["sh", "-c", "curl Bearer", "s3cr3t-value"], "sh -c 'curl Bearer' [REDACTED]"],
  ] as const)("redacts %s", (input, expected, argv, expectedArgv) => {
    for (const redact of [redactInventoryText, redactInventoryCommand]) {
      const redacted = redact(input)
      expect(redacted).toBe(expected)
      expect(backstopAccepts(redacted)).toBe(true)
      expect(redact(redacted)).toBe(redacted)
    }
    const command = redactInventoryArgv(argv)
    expect(command).toBe(expectedArgv)
    expect(backstopAccepts(command)).toBe(true)
  })

  // Other rules whose value is the next word read the original words too: a
  // private key's body after its header, and a header's value after a name
  // that ends at an unquoted colon.
  it.each([
    [
      "curl 'https://h/ -----BEGIN PRIVATE KEY-----' MIIEsecretbody '-----END PRIVATE KEY-----'",
      "curl 'https://h/[REDACTED]' [REDACTED]",
    ],
    ["curl 'https://h/ -H' X-Foo: s3cr3t-value", "curl 'https://h/[REDACTED]' X-Foo: [REDACTED]"],
  ])("redacts the next word's value in %s", (input, expected) => {
    for (const redact of [redactInventoryText, redactInventoryCommand]) {
      const redacted = redact(input)
      expect(redacted).toBe(expected)
      expect(backstopAccepts(redacted)).toBe(true)
      expect(redact(redacted)).toBe(redacted)
    }
  })

  it("redacts the value after a scheme word a URL read in through an operator", () => {
    const input = "curl https://h/?q&Bearer s3cr3t-value"
    expect(redactInventoryText(input)).toBe("curl https://h/?[REDACTED]'&[REDACTED]' [REDACTED]")
    expect(redactInventoryCommand(input)).toBe("curl https://h/'?[REDACTED]&[REDACTED]' [REDACTED]")
    for (const redact of [redactInventoryText, redactInventoryCommand]) expect(backstopAccepts(redact(input))).toBe(true)
  })

  it.each(hiddenTriggerPlacements.flatMap(([kind, place]) => hiddenTriggerWords.map((word) => [word, kind, place(word)] as const)))(
    "hides the value after %s at the end of %s",
    (_word, _kind, { text, argv }) => {
      for (const redact of [redactInventoryText, redactInventoryCommand]) {
        const redacted = redact(text)
        expect(redacted).not.toContain(hiddenTriggerCredential)
        expect(backstopAccepts(redacted)).toBe(true)
        expect(redact(redacted)).toBe(redacted)
      }
      const command = redactInventoryArgv(argv)
      expect(command).not.toContain(hiddenTriggerCredential)
      expect(backstopAccepts(command)).toBe(true)
    },
  )
})

// A word that makes the rest of its own shell word a value, inside a word a
// rule took whole without hiding that value (a URL's host or query name, a
// header's name before a kept scheme word): the word is hidden from there to
// its end, so its credential is never shown and the protocol does not refuse
// the text.
describe("a scheme word or sensitive flag and its value in one word another rule took", () => {
  it("hides the value in a URL's authority as text", () => {
    expect(redactInventoryText("curl 'https://host Token swordfish tail'")).toBe("curl 'https://host [REDACTED]'")
  })

  it("hides the value in a URL's authority as a command", () => {
    expect(redactInventoryCommand("curl 'https://host Token swordfish tail'")).toBe("curl 'https://host [REDACTED]'")
  })

  it("hides the value in a URL's authority as an argument vector", () => {
    expect(redactInventoryArgv(["curl", "https://host Token swordfish tail"])).toBe("curl 'https://host [REDACTED]'")
  })

  it.each([
    ["curl 'https://host Token x'", "curl 'https://host [REDACTED]'"],
    ["curl 'https://host --token swordfish'", "curl 'https://host [REDACTED]'"],
    ["curl 'https://user@host Token swordfish'", "curl 'https://[REDACTED]@host [REDACTED]'"],
    ["curl 'https://host/?Token swordfish=1'", "curl 'https://host/?[REDACTED]'"],
    ["curl 'https://host/p?a=1&--token swordfish=2#f'", "curl 'https://host/[REDACTED]?a=[REDACTED]&[REDACTED]'"],
    ["curl -H 'X-Api-Token: Bearer swordfish'", "curl -H '[REDACTED]'"],
    ["sh -c \"curl 'https://host Token swordfish tail'\"", "sh -c \"curl 'https://host [REDACTED]'\""],
    ["bash -lc \"curl 'https://host Token swordfish tail'\"", "bash -lc \"curl 'https://host [REDACTED]'\""],
    ["env MODE=x sh -c \"curl 'https://host Token swordfish tail'\"", "env MODE=[REDACTED] sh -c \"curl 'https://host [REDACTED]'\""],
    // A scheme word or header flag right after a URL's `?` or `#` is one too.
    ["curl 'https://host/#Bearer swordfish=1'", "curl 'https://host/#[REDACTED]'"],
    ["curl 'https://host/?-H X-Foo: swordfish=1'", "curl 'https://host/?[REDACTED]'"],
    // An assignment's value, and a sensitive key's that the protocol reads
    // as empty, run to the end of the word.
    ["curl 'https://host A=swordfish'", "curl 'https://host [REDACTED]'"],
    ["curl 'https://host --token ,swordfish'", "curl 'https://host [REDACTED]'"],
    // A value the URL hid keeps the query's other names.
    ["curl 'https://host/?access_token=zzz&mode=fast'", "curl 'https://host/?access_token=[REDACTED]&mode=[REDACTED]'"],
    // A quote escaped right after the marker in a double-quoted script is
    // single-quoted, so the backstop does not read a backslash as the value.
    ["bash -lc \"curl \\\"x Bearer swordfish\\\"\"", "bash -lc \"curl \\\"x Bearer [REDACTED]\"'\"'\"\""],
    ["bash -lc \"curl \\\"x --token swordfish\\\"\"", "bash -lc \"curl \\\"x --token [REDACTED]\"'\"'\"\""],
  ])("redacts %s", (input, expected) => {
    for (const redact of [redactInventoryText, redactInventoryCommand]) {
      const redacted = redact(input)
      expect(redacted).toBe(expected)
      expect(backstopAccepts(redacted)).toBe(true)
      expect(redact(redacted)).toBe(redacted)
    }
  })

  // Every trigger inside every place one word can hold it, its credential in
  // the same word, through text, command and argument vector, as written and
  // wrapped in shells and env.
  const redoneArgv = (command: string) => redactInventoryArgv(inventoryShellWords(command)!)
  it.each(sameWordPlacements.flatMap(([kind, place]) => sameWordWrappers.map(([wrapping, wrap]) => [kind, wrapping, sameWordCases(place, wrap)] as const)))(
    "hides the credential in %s %s",
    (_kind, _wrapping, cases) => {
      for (const { text, argv } of cases) {
        for (const redact of [redactInventoryText, redactInventoryCommand]) {
          const redacted = redact(text)
          for (const secret of sameWordCredentials) expect(redacted, text).not.toContain(secret)
          expect(backstopAccepts(redacted), `${text} -> ${redacted}`).toBe(true)
          expect(redact(redacted), text).toBe(redacted)
        }
        const command = redactInventoryArgv(argv)
        for (const secret of sameWordCredentials) expect(command, JSON.stringify(argv)).not.toContain(secret)
        expect(backstopAccepts(command), `${JSON.stringify(argv)} -> ${command}`).toBe(true)
        expect(redoneArgv(command), JSON.stringify(argv)).toBe(command)
      }
    },
  )
})

// Adversarial input, up to the reader's file limit, takes work that grows
// about linearly with its length through each entry point: counted, not timed.
describe("work on adversarial input", () => {
  const redactors: ReadonlyArray<readonly [string, (text: string) => string]> = [
    ["text", (text) => redactInventoryText(text)],
    ["command", (text) => redactInventoryCommand(text)],
    ["a script in an argument vector", (text) => redactInventoryArgv(["sh", "-c", text])],
    ["an argument vector of its words", (text) => redactInventoryArgv(text.split(" "))],
  ]
  it.each(adversarialCommands.flatMap(([name, size, generate]) => redactors.map(([kind, redact]) => [name, kind, size, generate, redact] as const)))(
    "redacts %s as %s in near-linear work",
    async (_name, _kind, size, generate, redact) => {
      const small = generate(size)
      const large = generate(size * 4)
      const { growth, results } = await workGrowth(() => redact(small), () => redact(large))
      for (const result of results) expect(backstopAccepts(result)).toBe(true)
      expect(growth).toBeLessThan(nearLinearGrowth)
    },
  )

  // The counter cannot see the scanning inside one regular expression search,
  // so input a pattern once searched in quadratic time is timed too.
  it.each(regexAdversaries)("fails the timing check for %s with the pattern that searched it", (_name, size, generate, pattern) => {
    const withPattern = (text: string) => redactInventoryCommand(pattern(text))
    const small = generate(size)
    const large = generate(size * 4)
    expect(timeGrowth(() => withPattern(small), () => withPattern(large))).toBeGreaterThanOrEqual(quadraticTimeGrowth)
  }, 30_000)

  it.each(regexAdversaries.flatMap(([name, size, generate]) => redactors.map(([kind, redact]) => [name, kind, size, generate, redact] as const)))(
    "redacts %s as %s in near-linear time",
    (_name, _kind, size, generate, redact) => {
      const small = generate(size)
      const large = generate(size * 4)
      expect(timeGrowth(() => redact(small), () => redact(large))).toBeLessThan(quadraticTimeGrowth)
    },
    30_000,
  )
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
    ["curl https://h.example.com/p?a=one\\&b=two", "curl https://h.example.com/[REDACTED]?a=[REDACTED]'&b=[REDACTED]'"],
    ["curl https://h.example.com/p?a=one\\;b=two x", "curl https://h.example.com/[REDACTED]?a=[REDACTED]';b=[REDACTED]' x"],
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
// turn one word into several or none, and the reader does not model them. A
// word of a command a shell runs never holds one unquoted: a command line
// keeps its source with each such character escaped, and an argument holding
// one is quoted. Text no shell runs (a rule, a matcher) keeps its source.
describe("pattern and brace characters in emitted words", () => {
  const textCases: ReadonlyArray<[string, string]> = [
    // A `?` is a pattern character, so in a command it is quoted when a
    // rewritten URL is written again.
    ["curl https://example.com/?q=1", "curl https://example.com/'?q=[REDACTED]'"],
    ["https://example.com/p?a=", "https://example.com/[REDACTED]'?a='"],
    ["curl https://u:p@h.example.com:8443/a/b?k=v&bare#f", "curl https://[REDACTED]@h.example.com:8443/[REDACTED]'?k=[REDACTED]&[REDACTED]#[REDACTED]'"],
    ["curl https://h.example.com/p?a=one\\&b=two", "curl https://h.example.com/[REDACTED]'?a=[REDACTED]&b=[REDACTED]'"],
    ["curl https://h.example.com/p?a=one\\;b=two x", "curl https://h.example.com/[REDACTED]'?a=[REDACTED];b=[REDACTED]' x"],
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

  it.each(textCases)("writes the command %j so no pattern expands", (input, expected) => {
    const redacted = redactInventoryCommand(input)
    expect(redacted).toBe(expected)
    expect(redacted).not.toMatch(/opaque-secret/u)
    expect(redactInventoryCommand(redacted)).toBe(redacted)
    expect(backstopAccepts(redacted)).toBe(true)
    // A shell's script is compared by the words it reads as in turn.
    const words = (text: string) => inventoryShellWords(text)!.map((word, index, all) => (index === 2 && /^(?:sh|bash)$/u.test(all[0]!) ? inventoryShellWords(word) : word))
    expect(words(redacted)).toEqual(words(redactInventoryText(input)))
  })

  // Text no shell runs keeps each pattern character as written.
  it.each([
    "Bash(pnpm test:*)",
    "bash git push *",
    "mcp__.*",
    "Edit|Write",
    "Read(src/**/*.ts)",
    "WebFetch(domain:*.example.com)",
    "echo {a,b} a?b a[bc]",
  ])("keeps the rule or matcher %j", (input) => {
    expect(redactInventoryText(input)).toBe(input)
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
  ])("keeps the command %j", (input) => {
    expect(redactInventoryCommand(input)).toBe(input)
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
      ...textCases.filter(([input]) => !/\$|sh -c|-lc/u.test(input)).map(([input]) => redactInventoryCommand(input)),
      ...argvCases.map(([argv]) => redactInventoryArgv(argv)),
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
  ])("redacts %j as text and as a command", (input, expected) => {
    for (const redact of [redactInventoryText, redactInventoryCommand]) {
      const redacted = redact(input)
      expect(redacted).toBe(expected)
      expect(redacted).not.toMatch(/opaque-secret/u)
      expect(redact(redacted)).toBe(redacted)
      expect(backstopAccepts(redacted)).toBe(true)
      expect(inventoryShellWords(redacted)).toBeDefined()
    }
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

// The protocol caps the length of each inventory text, and refuses a longer
// one, so the reader drops the entry. Redaction can write a text longer than
// it was given: a backslash before each pattern character, quotes around an
// argument, the marker after a short value or in place of a control
// character. Its output still fits the cap, whole words kept and the rest
// hidden behind the marker, so an entry the protocol would take before
// redaction is never dropped for it.
describe("output within the protocol's caps", () => {
  // The cap on a hook's or helper's command in the protocol's inventory schema.
  const commandCap = 2_048
  const rightToLeftOverride = String.fromCodePoint(0x202e)

  it("uses the protocol schema's cap for each field", () => {
    const base = { file: ".claude/settings.json", startsAtSessionStart: false, heldBack: true }
    const entries: Record<keyof typeof inventoryFieldCaps, ReadonlyArray<(value: string) => unknown>> = {
      command: [
        (value) => ({ ...base, kind: "hook", event: "Stop", command: value }),
        (value) => ({ ...base, kind: "helper", name: "apiKeyHelper", command: value }),
        (value) => ({ ...base, kind: "tool-server", name: "s", transport: "stdio", command: value, envKeys: [] }),
      ],
      event: [(value) => ({ ...base, kind: "hook", event: value, command: "x" })],
      matcher: [(value) => ({ ...base, kind: "hook", event: "Stop", matcher: value, command: "x" })],
      name: [
        (value) => ({ ...base, kind: "tool-server", name: value, transport: "stdio", command: "x", envKeys: [] }),
        (value) => ({ ...base, kind: "plugin", name: value }),
        (value) => ({ ...base, kind: "skill", name: value }),
      ],
      helperName: [(value) => ({ ...base, kind: "helper", name: value, command: "x" })],
      rule: [(value) => ({ ...base, kind: "permission-rule", rule: value, detail: "x" })],
      detail: [(value) => ({ ...base, kind: "permission-rule", rule: "allow", detail: value })],
    }
    expect(Object.keys(inventoryFieldCaps).sort()).toEqual(Object.keys(entries).sort())
    for (const [field, builds] of Object.entries(entries) as Array<[keyof typeof inventoryFieldCaps, ReadonlyArray<(value: string) => unknown>]>) {
      const cap = inventoryFieldCaps[field]
      for (const build of builds) {
        expect(toolInventoryEntrySchema.safeParse(build("x".repeat(cap))).success, field).toBe(true)
        expect(toolInventoryEntrySchema.safeParse(build("x".repeat(cap + 1))).success, field).toBe(false)
      }
    }
    expect(inventoryFieldCaps.command).toBe(commandCap)
  })

  const commandCases: ReadonlyArray<[string, string]> = [
    // Escaping each pattern character doubles its length.
    [`echo ${"*".repeat(1_022)}`, "echo [REDACTED]"],
    [`echo ${"*".repeat(1_021)}`, `echo ${"\\*".repeat(1_021)}`],
    [`echo x${"*".repeat(1_021)}`, `echo x${"\\*".repeat(1_021)}`],
    [`echo xx${"*".repeat(1_021)}`, "echo [REDACTED]"],
  ]

  it.each(commandCases)("fits the command %#", (input, expected) => {
    expect(input.length).toBeLessThanOrEqual(commandCap)
    const redacted = redactInventoryCommand(input)
    expect(redacted).toBe(expected)
    expect(redacted.length).toBeLessThanOrEqual(commandCap)
    expect(backstopAccepts(redacted)).toBe(true)
    expect(redactInventoryCommand(redacted)).toBe(redacted)
    expect(inventoryShellWords(redacted)).toEqual(expected === "echo [REDACTED]" ? ["echo", "[REDACTED]"] : ["echo", input.slice(5)])
  })

  // The marker in place of a control or format character is longer than it.
  const controlCases: ReadonlyArray<[string, string]> = [
    [`echo ${"a ".repeat(1_017)}${rightToLeftOverride}`, `echo${" a".repeat(1_016)} [REDACTED]`],
    [`echo ${"a ".repeat(1_016)}${rightToLeftOverride}`, `echo${" a".repeat(1_016)} [REDACTED]`],
    [`echo ab ${"a ".repeat(1_015)}${rightToLeftOverride}`, `echo ab${" a".repeat(1_015)} [REDACTED]`],
    [`echo abc ${"a ".repeat(1_015)}${rightToLeftOverride}`, `echo abc${" a".repeat(1_014)} [REDACTED]`],
  ]

  it.each(controlCases)("fits the text and command %#", (input, expected) => {
    expect(input.length).toBeLessThanOrEqual(commandCap)
    for (const redact of [redactInventoryText, redactInventoryCommand]) {
      const redacted = redact(input)
      expect(redacted).toBe(expected)
      expect(redacted.length).toBeLessThanOrEqual(commandCap)
      expect(backstopAccepts(redacted)).toBe(true)
      expect(redact(redacted)).toBe(redacted)
      expect(inventoryShellWords(redacted)?.at(-1)).toBe("[REDACTED]")
    }
  })

  // A text is fitted to the cap of the field it fills.
  const textCases: ReadonlyArray<[string, number, string]> = [
    [`${"x".repeat(1_008)} FOO=1`, 1_024, `${"x".repeat(1_008)} FOO=[REDACTED]`],
    [`${"x".repeat(1_009)} FOO=1`, 1_024, `${"x".repeat(1_009)} FOO=[REDACTED]`],
    [`${"x".repeat(1_010)} FOO=1`, 1_024, `${"x".repeat(1_010)} [REDACTED]`],
    [`${"x".repeat(243)} FOO=1`, 256, `${"x".repeat(243)} [REDACTED]`],
    // A rule keeps its pattern characters when it is fitted too.
    [`Bash(pnpm test:*) ${"x".repeat(100)}`, 64, "Bash(pnpm test:*) [REDACTED]"],
    ["x".repeat(65), 64, "[REDACTED]"],
  ]

  it.each(textCases)("fits the text %# to its cap", (input, cap, expected) => {
    const redacted = redactInventoryText(input, cap)
    expect(redacted).toBe(expected)
    expect(redacted.length).toBeLessThanOrEqual(cap)
    expect(backstopAccepts(redacted)).toBe(true)
    expect(redactInventoryText(redacted, cap)).toBe(redacted)
    expect(inventoryShellWords(redacted)).toBeDefined()
  })

  const argvCases: ReadonlyArray<[string[], string]> = [
    // Quotes around an argument add two characters.
    [["echo", "*".repeat(2_040)], `echo '${"*".repeat(2_040)}'`],
    [["echo", "*".repeat(2_041)], `echo '${"*".repeat(2_041)}'`],
    [["echo", "*".repeat(2_042)], "echo [REDACTED]"],
    // A single quote is written in five characters.
    [["echo", "'".repeat(500)], "echo [REDACTED]"],
    [["echo", ...Array.from({ length: 1_017 }, () => "a"), rightToLeftOverride], `echo${" a".repeat(1_016)} [REDACTED]`],
  ]

  it.each(argvCases)("fits the argument vector %#", (argv, expected) => {
    expect(argv.join(" ").length).toBeLessThanOrEqual(commandCap)
    const redacted = redactInventoryArgv(argv)
    expect(redacted).toBe(expected)
    expect(redacted.length).toBeLessThanOrEqual(commandCap)
    expect(backstopAccepts(redacted)).toBe(true)
    expect(inventoryShellWords(redacted)).toEqual(inventoryShellWords(expected))
  })

  // Count the characters a string method builds while one redaction runs.
  // Fitting a long input to the cap builds the shortened output once, not
  // again for each word dropped: eight times the words builds about eight
  // times as much, and a rebuild per dropped word about sixty-four times.
  const built = <T>(target: T, method: keyof T & string, run: () => string) => {
    let total = 0
    const original = target[method] as (this: unknown, ...args: unknown[]) => unknown
    const spy = vi.spyOn(target as Record<string, (...args: unknown[]) => unknown>, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args)
      if (typeof result === "string") total += result.length
      return result
    })
    let output: string
    try {
      output = run()
    } finally {
      spy.mockRestore()
    }
    return { output, total }
  }
  const words = (count: number) => Array.from({ length: count }, () => "a")

  it("fits a long argument vector without building its line again per argument", () => {
    const small = built(Array.prototype, "join", () => redactInventoryArgv(["echo", ...words(2_500)]))
    const large = built(Array.prototype, "join", () => redactInventoryArgv(["echo", ...words(20_000)]))
    for (const { output } of [small, large]) expect(output).toBe(`echo${" a".repeat(1_016)} [REDACTED]`)
    expect(large.total / small.total).toBeLessThan(12)
  })

  it.each([
    ["text", (text: string) => redactInventoryText(text), `a${" a".repeat(1_018)} [REDACTED]`],
    ["command", (text: string) => redactInventoryCommand(text), `a${" a".repeat(1_018)} [REDACTED]`],
  ] as const)("fits a long %s without building it again per word", (_kind, redact, expected) => {
    const small = built(String.prototype, "slice", () => redact(words(2_500).join(" ")))
    const large = built(String.prototype, "slice", () => redact(words(20_000).join(" ")))
    for (const { output } of [small, large]) expect(output).toBe(expected)
    expect(large.total / small.total).toBeLessThan(12)
  })

  // The outputs at the cap, read by real shells in a directory where each
  // pattern would match.
  describe.skipIf(process.platform === "win32")("read by a shell", () => {
    let directory = ""
    beforeAll(() => {
      directory = mkdtempSync(join(tmpdir(), "domovoi-inventory-cap-"))
      for (const name of ["x", "xa", "a"]) writeFileSync(join(directory, name), "")
    })
    afterAll(() => rmSync(directory, { recursive: true, force: true }))

    const shells = ["/bin/sh", "/bin/bash"].filter((shell) => existsSync(shell))
    const outputs = [redactInventoryCommand(`echo x${"*".repeat(1_021)}`), redactInventoryArgv(["echo", "*".repeat(2_041)])]
    it.each(shells.flatMap((shell) => outputs.map((output, index) => [shell, index, output] as const)))("%s reads output %i as the reader does", (shell, _index, output) => {
      const words = execFileSync(shell, ["-c", `set -- ${output}; printf '%s\\0' "$@"`], {
        cwd: directory, encoding: "utf8", env: { PATH: "/usr/bin:/bin" },
      }).split("\0").slice(0, -1)
      expect(words).toEqual(inventoryShellWords(output))
    })
  })
})
