// A backstop for text a provider's own file supplied. The daemon's reader must
// redact before it emits: every `NAME=value` assignment, every value of a
// sensitive key, flag or authorization scheme, and all URL user info read
// `[REDACTED]`. This check does not redact. It refuses text that still
// carries such a value, so a reader that missed one fails instead of leaking.
// It knows forms, not secrets: a credential in a form it does not read passes.
//
// Each text is read as sent and after one layer of decoding (percent escapes,
// backslash and \u escapes), then every key and its value is judged the same
// way whatever quoting or punctuation joins them: `K=v`, `"K=v"`, `"K": "v"`,
// `K: v`, `--k=v`, `--k v`.

const marker = "[REDACTED]"

const keyPairs = new RegExp(String.raw`(?<![\p{L}\p{N}_.\-])(-{1,2})?(["'\x60]?)([A-Za-z_][A-Za-z0-9_.\-]*)(["'\x60]?)(?=(\s*[=:]\s*|\s+)(["'\x60]?)([^\s"'\x60,;}&|)]*))`, "gu")
const sensitiveParts = ["apikey", "accesskey", "privatekey", "sessionkey", "token", "password", "passwd", "secret", "credential", "cookie", "authorization"]
// A key that names where a secret lives rather than holding it.
// A key that names where a secret lives, or counts something, rather than
// holding it: --token-file, --api-key-env, --max-tokens.
const pointerSuffixes = ["file", "path", "dir", "env", "name", "type", "helper", "command", "cmd", "url", "tokens", "tokenizer", "count", "limit", "length", "size"]
const schemes = new Set(["bearer", "basic", "token", "digest"])

function isSensitive(key: string): boolean {
  const flat = key.toLowerCase().replace(/[-_.]/gu, "")
  if (flat === "auth" || flat === "pat") return true
  return sensitiveParts.some((part) => flat.includes(part)) && !pointerSuffixes.some((suffix) => flat.endsWith(suffix))
}

// A value after a sensitive key is a credential unless it is the marker alone.
const redacted = (value: string) => value === marker

function pairHoldsValue(flag: string, quoteAfterKey: string, key: string, separator: string, value: string): boolean {
  if (value === "") return false
  const joinedBy = separator.trim()
  const envName = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
  if (joinedBy === "") {
    // `--key value`: only a flag takes the next word as its value.
    return flag !== "" && isSensitive(key) && !value.startsWith("-") && !redacted(value)
  }
  if (isSensitive(key)) {
    // `Authorization: Bearer ...` names a scheme; the scheme rule judges its token.
    if (key.toLowerCase() === "authorization" && schemes.has(value.toLowerCase())) return false
    return !redacted(value)
  }
  if (joinedBy === "=") return flag === "" && envName && !redacted(value)
  // `"K": v` and `K_NAME: v`: an environment-style name as a JSON or YAML key.
  // Unquoted, it needs an underscore, so an error code such as `EACCES: ...`
  // stays readable.
  const environmentStyle = /^[A-Z_][A-Z0-9_]+$/u.test(key)
  const keyForm = quoteAfterKey !== "" || (/\s$/u.test(separator) && key.includes("_"))
  return environmentStyle && keyForm && !redacted(value)
}

// An authorization scheme and the word after it.
const schemeValues = /\b(?:Bearer|Basic|Token|Digest)\s+["'\x60]?([^\s"'\x60,;)]+)/giu
// A credential looks like one: a digit or token punctuation, or a capital past
// its first letter. "Bearer Authentication" is a name; "Bearer dXNlcjpw" is not.
const tokenLike = (value: string) => !redacted(value) && value.length >= 6 && /[0-9._~+/=-]|.\p{Lu}/u.test(value)

const shapes: readonly RegExp[] = [
  // Any user info in a URL authority, with or without a password.
  /:\/\/(?!\[REDACTED\]@)[^\s/?#@]+@/u,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/u,
  /\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
]

function decoded(value: string): string[] {
  const percent = value.replace(/%([0-9A-Fa-f]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  const unescape = (text: string) => text
    .replace(/\\u([0-9A-Fa-f]{4})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\(.)/gu, "$1")
  return [...new Set([value, percent, unescape(value), unescape(percent)])]
}

export function holdsCredential(value: string): boolean {
  return decoded(value).some((view) => {
    if (shapes.some((shape) => shape.test(view))) return true
    for (const [, schemeValue = ""] of view.matchAll(schemeValues)) if (tokenLike(schemeValue)) return true
    for (const match of view.matchAll(keyPairs)) {
      const [, flag = "", , key = "", quoteAfterKey = "", separator = "", , pairValue = ""] = match
      if (pairHoldsValue(flag, quoteAfterKey, key, separator, pairValue)) return true
    }
    return false
  })
}
