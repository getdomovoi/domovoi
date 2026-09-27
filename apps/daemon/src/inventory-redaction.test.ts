import { toolInventoryEntrySchema } from "@getdomovoi/protocol"
import { describe, expect, it } from "vitest"

import { redactInventoryArgv, redactInventoryText } from "./inventory-redaction.js"

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
    ["sh -c \"curl -H \\\"X-Custom: v\\\" x\"", "sh -c \"curl -H \\\"X-Custom: [REDACTED]\\\" x\""],
    ["sh -c \"curl -H \\\"X-Custom: v x\"", "sh -c \"curl -H \\\"X-Custom: [REDACTED]\""],
    // A header name takes every RFC 9110 token character, quote marks included.
    ["curl -H \"X'Foo: s3cr3t-value\" x", "curl -H \"X'Foo: [REDACTED]\" x"],
    ["curl -H 'X`Foo: s3cr3t-value' x", "curl -H 'X`Foo: [REDACTED]' x"],
    ["curl -H \"!#$%&'*+-.^_`|~Az09: s3cr3t-value\" x", "curl -H \"!#$%&'*+-.^_`|~Az09: [REDACTED]\" x"],
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
    ["sh -c \"curl -H X-Foo: \\\"s3cr3t value\\\" x\"", "sh -c \"curl -H X-Foo: \\\"[REDACTED]\\\" x\""],
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
    expect(once).toBe("curl https://[REDACTED]@h.example.com:8443/[REDACTED]?k=[REDACTED]&[REDACTED]#[REDACTED]")
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
      "curl -H \"X-Custom: [REDACTED]\" \"--header=X-Other: [REDACTED]\" \"-HX-Third: [REDACTED]\" --proxy-header \"X-Proxy: [REDACTED]\" https://example.com/[REDACTED]?[REDACTED]#[REDACTED]",
    )
    expect(backstopAccepts(command)).toBe(true)
  })

  it("redacts header values whose names hold quote marks", () => {
    const command = redactInventoryArgv(["curl", "-H", "X'Foo: s3cr3t-value", "--header=X`Bar: hunter2", "-HX'Baz: tok-abc"])
    expect(command).toBe("curl -H \"X'Foo: [REDACTED]\" \"--header=X`Bar: [REDACTED]\" \"-HX'Baz: [REDACTED]\"")
    expect(backstopAccepts(command)).toBe(true)
  })

  it("redacts the next argument after a header that ends at its colon", () => {
    const command = redactInventoryArgv([
      "curl", "-H", "X-Foo:", "s3cr3t-value", "-HX-Bar:", "hunter2", "--header=X-Baz:", "tok abc", "-H", "X-Empty:", "-H", "X-Real: q-secret", "x",
    ])
    expect(command).toBe("curl -H X-Foo: [REDACTED] -HX-Bar: [REDACTED] --header=X-Baz: [REDACTED] -H X-Empty: -H \"X-Real: [REDACTED]\" x")
    expect(backstopAccepts(command)).toBe(true)
  })

  it("redacts a URL's whole path and keeps a bare host", () => {
    const command = redactInventoryArgv([
      "curl", "https://hooks.example.com/services/T0/B0/XXXX", "--url", "https://example.com/", "https://example.com", "https://h.example.com/a?key=v#f",
    ])
    expect(command).toBe("curl https://hooks.example.com/[REDACTED] --url https://example.com/ https://example.com https://h.example.com/[REDACTED]?key=[REDACTED]#[REDACTED]")
    expect(backstopAccepts(command)).toBe(true)
  })

  it("redacts a quoted header name with its value glued on", () => {
    const command = redactInventoryArgv(["curl", "-H", "'X-Foo':s3cr3t-value", "-H", "\"X-Bar\":hunter2", "--header='X-Baz':tok-abc"])
    expect(command).toBe("curl -H \"'X-Foo':[REDACTED]\" -H \"\\\"X-Bar\\\":[REDACTED]\" \"--header='X-Baz':[REDACTED]\"")
    expect(backstopAccepts(command)).toBe(true)
    const shell = redactInventoryArgv(["sh", "-c", "curl -H 'X-Foo':s3cr3t-value x"])
    expect(shell).toBe("sh -c \"curl -H 'X-Foo':[REDACTED] x\"")
    expect(backstopAccepts(shell)).toBe(true)
  })

  // An argument is not shell text, so a backtick in a name needs no escape;
  // a header argument that still does not read as a header is redacted whole.
  it("redacts a header argument that does not read as a header", () => {
    const command = redactInventoryArgv(["curl", "-H", "X`Foo: opaque-secret", "-H", "X Foo: hunter2", "--header=X(Foo): tok-abc", "-H", "@headers.txt"])
    expect(command).toBe("curl -H \"X`Foo: [REDACTED]\" -H [REDACTED] --header=[REDACTED] -H @headers.txt")
    expect(backstopAccepts(command)).toBe(true)
  })

  it("redacts a URL path that holds quote marks", () => {
    const command = redactInventoryArgv(["curl", "https://hooks.example.com/'opaque-secret'", "https://h.example.com/a\"b\"c"])
    expect(command).toBe("curl https://hooks.example.com/[REDACTED] https://h.example.com/[REDACTED]")
    expect(backstopAccepts(command)).toBe(true)
  })

  it("quotes an argument that holds spaces", () => {
    expect(redactInventoryArgv(["sh", "-c", "echo hi"])).toBe("sh -c \"echo hi\"")
  })
})
