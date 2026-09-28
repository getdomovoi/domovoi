import { performance } from "node:perf_hooks"

import { describe, expect, it } from "vitest"

import { credentialRules, credentialShapeAt, holdsCredential, isCredentialKey, type CredentialRules } from "./index.js"

// The daemon's reader takes these rules from here, so each must be the rule
// the backstop itself reads, frozen so no importer can change it for another.
describe("credential rules", () => {
  const lists = Object.entries(credentialRules) as Array<[keyof CredentialRules, readonly string[]]>

  it("exports frozen lists of distinct lower-case words", () => {
    expect(Object.isFrozen(credentialRules)).toBe(true)
    expect(lists.map(([name]) => name).sort()).toEqual(["exactKeys", "keyParts", "pointerSuffixes", "schemeWords", "tokenPrefixes"])
    for (const [name, words] of lists) {
      expect(Object.isFrozen(words), name).toBe(true)
      expect(words.length, name).toBeGreaterThan(0)
      expect(new Set(words).size, name).toBe(words.length)
      for (const word of words) expect(word, name).toMatch(/^[a-z][a-z0-9_]*$/u)
    }
  })

  it("refuses a value after every scheme word, key and token prefix it exports", () => {
    for (const word of credentialRules.schemeWords) {
      for (const spelling of [word, word.toUpperCase(), `${word[0]!.toUpperCase()}${word.slice(1)}`]) {
        expect(holdsCredential(`curl ${spelling} madeup-value`), spelling).toBe(true)
      }
    }
    for (const key of [...credentialRules.keyParts, ...credentialRules.exactKeys]) {
      expect(isCredentialKey(key), key).toBe(true)
      for (const text of [`tool --${key} madeupvalue`, `tool --${key}=madeupvalue`, `{"${key}": "madeupvalue"}`, `${key}: madeupvalue`]) {
        expect(holdsCredential(text), text).toBe(true)
      }
    }
    for (const prefix of credentialRules.tokenPrefixes) {
      for (const text of [`run ${prefix}-abcdefgh`, `run ${prefix}_abcdefgh`]) {
        expect(credentialShapeAt(text), text).toBe(4)
        expect(holdsCredential(text), text).toBe(true)
      }
    }
  })

  it("does not take a key that names where a secret lives or counts something for one", () => {
    for (const suffix of credentialRules.pointerSuffixes) {
      const key = `token-${suffix}`
      expect(isCredentialKey(key), key).toBe(false)
      expect(holdsCredential(`tool --${key} value`), key).toBe(false)
    }
    // A part inside a longer word is still a sensitive key; an exact key is
    // only one as the whole name.
    expect(isCredentialKey("X-Api-Token")).toBe(true)
    expect(isCredentialKey("client_secret")).toBe(true)
    expect(isCredentialKey("path")).toBe(false)
    expect(isCredentialKey("author")).toBe(false)
  })

  it("reads a key by the rules it is given", () => {
    const added: CredentialRules = { ...credentialRules, keyParts: [...credentialRules.keyParts, "authcode"], exactKeys: [] }
    expect(isCredentialKey("--authcode")).toBe(false)
    expect(isCredentialKey("--authcode", added)).toBe(true)
    expect(isCredentialKey("auth", added)).toBe(false)
  })
})

describe("credential shapes", () => {
  // The patterns the backstop searched with before it found shapes in linear
  // work; each shape must be found exactly where one of them matches.
  const earlier: readonly RegExp[] = [
    /:\/\/(?!\[REDACTED\]@)[^\s/?#@]+@/u,
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/u,
    /\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/u,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  ]
  const tokens = [
    "eyJabcde.abcdef.abcdef", "eyJabcd.abcdef.abcdef", "eyJabcde.abcde.abcdef", "eyJabcde.abcdef.abcde", "xeyJabcde.abcdef.abcdef",
    "-eyJabcde.abcdef.abcdef", "eyJ-eyJabcde.abcdef.abcdef", "eyJeyJabcdefgh.abcdef.abcdef", "eyJabcde.eyJabcdef.abcdef.abcdef",
    "sk-abcdefgh", "sk-abcdefg", "xsk-abcdefgh", "ghp_abcdefgh1234", "github_pat_abcdefgh", "xoxb-abcdefgh", "xoxc-abcdefgh",
    "AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNO", "ASIAABCDEFGHIJKLMNOPQ", "https://user@host", "https://[REDACTED]@host",
    "https://u:p@h/x", "https://host/@x", "://@x", "-----BEGIN PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY-----", "-----BEGIN PUBLIC KEY-----",
  ]
  const corpus = tokens.flatMap((token) => [token, `run ${token}`, `a/${token} b`, `"${token}"`, `${token}.x`])

  it("finds a shape exactly where the earlier patterns did", () => {
    for (const text of corpus) {
      const matches = earlier.flatMap((pattern) => {
        const match = pattern.exec(text)
        // User info starts after the `://` the earlier pattern matched from.
        return match === null ? [] : [pattern === earlier[0] ? match.index + 3 : match.index]
      })
      expect(credentialShapeAt(text), text).toBe(matches.length === 0 ? undefined : Math.min(...matches))
    }
  })

  // How much longer four times a JSON Web Token near-miss takes to search:
  // linear work is about 4 times, and the earlier pattern about 16.
  const leastTime = (run: () => unknown) => {
    run()
    let least = Number.POSITIVE_INFINITY
    for (let index = 0; index < 5; index += 1) {
      const start = performance.now()
      run()
      least = Math.min(least, performance.now() - start)
    }
    return least
  }
  const growth = (search: (text: string) => unknown) => {
    const small = "eyJ-".repeat(1_024)
    const large = "eyJ-".repeat(4_096)
    let least = Number.POSITIVE_INFINITY
    for (let attempt = 0; attempt < 3 && least >= 7; attempt += 1) least = Math.min(least, leastTime(() => search(large)) / leastTime(() => search(small)))
    return least
  }

  it("searches a long run of token-shaped text in near-linear time", () => {
    expect(growth(credentialShapeAt)).toBeLessThan(7)
    expect(growth(holdsCredential)).toBeLessThan(7)
  }, 30_000)

  it("fails the same timing check with the earlier pattern", () => {
    expect(growth((text) => earlier[1]!.test(text))).toBeGreaterThanOrEqual(7)
  }, 30_000)
})
