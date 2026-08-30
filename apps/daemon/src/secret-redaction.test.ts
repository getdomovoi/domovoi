import { describe, expect, it } from "vitest"

import {
  DurableOutputRedactor,
  maximumDurableCommandLength,
  maximumStreamingOutputBufferLength,
  redactDurableCommand,
  redactDurableOutput,
  redactDurableText,
} from "./secret-redaction.js"

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
