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
    ["curl https://tok@example.com/x", "curl https://[REDACTED]@example.com/x"],
    ["curl https://user:pass@example.com:8443/x", "curl https://[REDACTED]@example.com:8443/x"],
    ["curl 'https://example.com/p?key=abc&mode=fast'", "curl 'https://example.com/p?key=[REDACTED]&mode=[REDACTED]'"],
    ["open https://example.com/cb#access_token=zzz", "open https://example.com/cb#access_token=[REDACTED]"],
    // A query or fragment part without an equals sign is a value too.
    ["open https://example.com/cb#opaque-fragment-secret", "open https://example.com/cb#[REDACTED]"],
    ["curl 'https://example.com/p?token-without-equals'", "curl 'https://example.com/p?[REDACTED]'"],
    ["curl 'https://example.com/p?a=1&bare;b=&d#x;c=2'", "curl 'https://example.com/p?a=[REDACTED]&[REDACTED];b=&[REDACTED]#[REDACTED];c=[REDACTED]'"],
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
    "https://example.com/path",
    "https://example.com/p?a=",
    "curl -H @headers.txt x",
    "grep -Hn pattern file",
  ])("keeps %j", (input) => {
    expect(redactInventoryText(input)).toBe(input)
  })

  it("is idempotent", () => {
    const once = redactInventoryText("A=1 curl -u https://u:p@h/?q=1&bare#frag --token t -H 'X-Custom: v' -H 'Authorization: Bearer t'")
    expect(redactInventoryText(once)).toBe(once)
    expect(backstopAccepts(once)).toBe(true)
  })
})

describe("redactInventoryArgv", () => {
  it("redacts sensitive flag values, assignments and user info per argument", () => {
    const command = redactInventoryArgv([
      "npx", "server", "--api-key", "abc", "DATABASE_URL=postgres://u:p@h/db", "--url", "https://t@h/x", "env", "PASSWORD=correct horse",
    ])
    expect(command).toBe("npx server --api-key [REDACTED] DATABASE_URL=[REDACTED] --url https://[REDACTED]@h/x env PASSWORD=[REDACTED]")
    expect(backstopAccepts(command)).toBe(true)
  })

  it("redacts header values and bare query and fragment parts per argument", () => {
    const command = redactInventoryArgv([
      "curl", "-H", "X-Custom: opaque-header-secret", "--header=X-Other: v2", "-HX-Third: v3", "--proxy-header", "X-Proxy: v4",
      "https://example.com/cb?bare-query-secret#opaque-fragment-secret",
    ])
    expect(command).toBe(
      "curl -H \"X-Custom: [REDACTED]\" \"--header=X-Other: [REDACTED]\" \"-HX-Third: [REDACTED]\" --proxy-header \"X-Proxy: [REDACTED]\" https://example.com/cb?[REDACTED]#[REDACTED]",
    )
    expect(backstopAccepts(command)).toBe(true)
  })

  it("quotes an argument that holds spaces", () => {
    expect(redactInventoryArgv(["sh", "-c", "echo hi"])).toBe("sh -c \"echo hi\"")
  })
})
