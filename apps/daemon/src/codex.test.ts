import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"

import { parse as parseToml } from "smol-toml"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Runtime } from "@getdomovoi/protocol"

vi.mock("@getdomovoi/protocol", async (importOriginal) => ({
  ...await importOriginal<typeof import("@getdomovoi/protocol")>(),
  buildVersion: "9.8.7-test",
}))

import {
  CodexAppServerAdapter,
  StdioCodexTransport,
  codexAppServerArguments,
  codexDeveloperInstructions,
  codexPolicyFor,
  codexRequestRefusal,
  codexSandboxNotice,
  codexSecretGlobs,
  codexSecretLocations,
  codexWorktreeSecretNotice,
  type CodexTransport,
  type JsonRpcMessage,
} from "./codex.js"
import { ApprovalRequestNotPendingError, type AgentEvent } from "./agents.js"
import { credentialStores } from "./credential-stores.js"
import { namesSecretPath } from "./permission-policy.js"
import { classifyProviderFailure } from "./provider-failures.js"

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  ignoreSignals = false
  readonly signals: NodeJS.Signals[] = []

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal)
    if (this.ignoreSignals) return true
    queueMicrotask(() => {
      this.signalCode = signal
      this.emit("exit", null, signal)
      this.emit("close", null, signal)
    })
    return true
  }
}

class FakeTransport implements CodexTransport {
  readonly sent: JsonRpcMessage[] = []
  closeCount = 0
  closeGate: Promise<void> | undefined
  throwOnMethod: string | undefined
  #listener: ((message: JsonRpcMessage) => void) | undefined
  #errorListener: ((error: Error) => void) | undefined
  #staleListener: ((message: JsonRpcMessage) => void) | undefined
  #staleErrorListener: ((error: Error) => void) | undefined

  send(message: JsonRpcMessage): void {
    if (this.throwOnMethod && message.method === this.throwOnMethod) {
      throw new Error(`Failed to send ${message.method}`)
    }
    this.sent.push(message)
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.#listener = listener
    this.#staleListener = listener
    return () => {
      this.#listener = undefined
    }
  }

  receive(message: JsonRpcMessage): void {
    this.#listener?.(message)
  }

  receiveStale(message: JsonRpcMessage): void {
    this.#staleListener?.(message)
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errorListener = listener
    this.#staleErrorListener = listener
    return () => { this.#errorListener = undefined }
  }

  fail(error: Error): void {
    this.#errorListener?.(error)
  }

  failStale(error: Error): void {
    this.#staleErrorListener?.(error)
  }

  async close(): Promise<void> {
    this.closeCount += 1
    await this.closeGate
  }

  environmentIsLocalOnly?(): boolean
}

const runtime = (permissionMode: Runtime["permissionMode"], auto: boolean): Runtime => ({
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoning: "medium",
  permissionMode,
  auto,
})

describe("codexPolicyFor", () => {
  it.each([
    [runtime("ask", false), "on-request", "domovoi-read"],
    [runtime("plan", false), "never", "domovoi-read"],
    [runtime("build", false), "on-request", "domovoi-build"],
    [runtime("build", true), "never", "domovoi-build"],
  ] as const)("maps Domovoi runtime to Codex enforcement", (input, approvalPolicy, permissions) => {
    const policy = codexPolicyFor(input)
    // Every approval goes to the person, whatever approvals_reviewer the
    // person's own Codex configuration sets (walk finding F15).
    expect(policy).toEqual({ approvalPolicy, permissions, approvalsReviewer: "user" })
  })
})

describe("codexAppServerArguments", () => {
  const settings = new Map<string, string>()
  const argumentsList = codexAppServerArguments()
  for (let index = 0; index < argumentsList.length; index += 1) {
    if (argumentsList[index] !== "-c") continue
    const setting = argumentsList[index + 1]!
    const separator = setting.indexOf("=")
    settings.set(setting.slice(0, separator), setting.slice(separator + 1))
  }

  it("serves stdio and defines the two profiles Domovoi selects per turn", () => {
    expect(argumentsList.slice(0, 3)).toEqual(["app-server", "--listen", "stdio://"])
    expect(settings.get("permissions.domovoi-read.extends")).toBe('":read-only"')
    expect(settings.get("permissions.domovoi-build.extends")).toBe('":workspace"')
    expect(settings.get("permissions.domovoi-read.network.enabled")).toBe("false")
    expect(settings.get("permissions.domovoi-build.network.enabled")).toBe("false")
  })

  it("denies secret files inside the worktree in both profiles", () => {
    for (const profile of ["domovoi-read", "domovoi-build"]) {
      const workspace = filesystemTable(process.platform, profile)[":workspace_roots"]
      expect(Object.keys(workspace ?? {})).toEqual([...codexSecretGlobs()])
      expect(Object.values(workspace ?? {}).every((access) => access === "deny")).toBe(true)
    }
  })

  // T109 review round 4: the card classifier ignores letter case and finds a
  // private key name where a word starts, and the sandbox globs did neither.
  // Every name it calls secret, in any case, with a prefix where it allows
  // one, nested and as a directory, is refused in the thread's own worktree
  // (:workspace_roots) and in every session worktree, in both profiles. Codex
  // compares globs with letter case on Linux, and without it on Windows and in
  // Seatbelt, which refused DAEMON.TOKEN by **/daemon.token on a case-sensitive
  // APFS volume too (measured with codex-cli 0.162.1).
  describe.each(["darwin", "linux", "win32"] as const)("on %s", (platform) => {
    const ignoresCase = platform !== "linux"
    const tables = ["domovoi-read", "domovoi-build"].map((profile) => filesystemTable(platform, profile))

    // Each glob is compiled once: the walk below makes about 3,000 checks per
    // table, and compiling per check outran the default timeout in CI.
    const refusers = (options: GlobOptions) => tables.map((table) => {
      const workspace = Object.keys(table[":workspace_roots"] ?? {}).map((pattern) => globRegExp(pattern, options))
      const worktrees = Object.keys(table).filter((key) => key.startsWith("~/.domovoi/worktrees/")).map((pattern) => globRegExp(pattern, options))
      return {
        workspace: (path: string) => workspace.some((pattern) => pattern.test(path)),
        worktree: (path: string) => worktrees.some((pattern) => pattern.test(`~/.domovoi/worktrees/session-1/${path}`)),
      }
    })

    it("refuses every name the classifier calls secret, in any letter case", () => {
      const paths = classifierSecretSamples.flatMap((sample) => letterCases(sample).flatMap((name) => [name, `deep/dir/${name}`]))
      for (const path of paths) expect(namesSecretPath(path), path).toBe(true)
      for (const refuses of refusers({ ignoresCase })) {
        for (const path of paths) {
          expect(refuses.workspace(path), path).toBe(true)
          expect(refuses.worktree(path), `session worktree: ${path}`).toBe(true)
        }
      }
    })

    it("keeps ordinary project files readable, in any letter case", () => {
      const paths = ordinaryProjectFiles.flatMap(letterCases)
      for (const path of paths) expect(namesSecretPath(path), path).toBe(false)
      // Seatbelt compares without letter case and lets [!c] match a slash.
      for (const options of [{ ignoresCase }, { ignoresCase: true, classMatchesSlash: true }]) {
        for (const refuses of refusers(options)) {
          for (const path of paths) {
            expect(refuses.workspace(path), path).toBe(false)
            expect(refuses.worktree(path), `session worktree: ${path}`).toBe(false)
          }
        }
      }
    })

    it("writes each profile's filesystem table as TOML that parses, with no repeated key", () => {
      for (const profile of ["domovoi-read", "domovoi-build"]) {
        const value = codexAppServerArguments(platform).find((setting) => setting.startsWith(`permissions.${profile}.filesystem=`))!
        expect(() => parseToml(`filesystem = ${value.slice(value.indexOf("=") + 1)}`)).not.toThrow()
      }
    })

  })

  // #867 review: Seatbelt reads a regex of at most 1,017 bytes and a profile of
  // about 1 MB (sandbox-exec takes it as one argument), and past either refuses
  // the whole profile, so every sandboxed command (measured with codex-cli
  // 0.162.1). Codex writes each :workspace_roots glob after the worktree's
  // absolute path, escaped, with a rule for each of its ancestor directories,
  // so both grow with the path and its depth. The profile loads for a
  // worktree path Seatbelt writes in up to 768 bytes (a dot, hyphen or other
  // punctuation counts twice), three quarters of macOS's 1,024-byte path
  // limit, in names of five bytes or more. Names of two bytes, about 380
  // directories deep, overran T109's eight patterns there too.
  it.each([
    { component: 5, hyphens: false }, { component: 10, hyphens: false }, { component: 50, hyphens: false },
    { component: 10, hyphens: true },
  ])("loads on macOS for a worktree path Seatbelt writes in 768 bytes: $component-byte names, hyphens $hyphens", ({ component, hyphens }) => {
    const table = filesystemTable("darwin", "domovoi-read")
    const home = worktreePath(64, 8)
    const root = worktreePath(768, component, hyphens)
    expect(seatbeltRegex(root, false).length - 2).toBe(768)
    const workspace = seatbeltGlobPolicy(Object.keys(table[":workspace_roots"] ?? {}).map((glob) => `${root}/${glob}`))
    const rest = seatbeltGlobPolicy(Object.keys(table).filter((key) => key !== ":workspace_roots" && /[*?[{]/u.test(key)).map((key) => key.replace(/^~/u, home)))
    expect(Math.max(workspace.longestRegex, rest.longestRegex)).toBeLessThanOrEqual(1_017)
    expect(workspace.bytes + rest.bytes).toBeLessThanOrEqual(800_000)
  })

  // Windows starts a program with one command line of at most 32,767
  // characters, and the profiles travel on it.
  it("fits the Windows command line", () => {
    const line = codexAppServerArguments("win32").map((argument) => `"${argument.replaceAll('"', '\\"')}"`).join(" ")
    expect(line.length).toBeLessThan(32_767 - 1_024)
  })

  it.each([
    "~/.ssh", "~/.aws", "~/.config/gh", "~/.kube", "~/.docker", "~/.netrc", "~/.gnupg",
  ])("denies reads of %s in both profiles", (location) => {
    for (const profile of ["domovoi-read", "domovoi-build"]) {
      expect(settings.get(`permissions.${profile}.filesystem`)).toContain(`${JSON.stringify(location)}="deny"`)
    }
    expect(codexSecretLocations).toContain(location)
  })

  // Walk finding F15: session worktrees live in ~/.domovoi/worktrees. Codex
  // 0.162.1 keeps every deny entry when it runs an approved command outside
  // its sandbox, and a deny on ~/.domovoi outranked the worktree, so Ask could
  // not read the worktree and an approved write failed with "Operation not
  // permitted". The store is refused name by name, everything but worktrees.
  // Codex reads each -c value as TOML and takes one that does not parse, a
  // repeated key included, as a plain string, which fails the profile.
  it("writes each profile's filesystem table as TOML that parses", () => {
    for (const profile of ["domovoi-read", "domovoi-build"]) {
      expect(() => parseToml(`filesystem = ${settings.get(`permissions.${profile}.filesystem`)!}`)).not.toThrow()
    }
  })

  it("refuses everything in ~/.domovoi except the session worktrees in both profiles", () => {
    expect(codexSecretLocations).toContain("~/.domovoi")
    for (const profile of ["domovoi-read", "domovoi-build"]) {
      const filesystem = settings.get(`permissions.${profile}.filesystem`)!
      expect(filesystem).not.toContain('"~/.domovoi"="deny"')
      // Keys read as TOML, which decodes the escapes the secret globs need.
      const denied = Object.keys(filesystemTable(process.platform, profile)).filter((key) => key.startsWith("~/.domovoi/"))
      const refused = (path: string) => denied.some((pattern) => globMatches(pattern, path))
      for (const path of [
        "~/.domovoi/daemon.token", "~/.domovoi/local-owner.key", "~/.domovoi/state.sqlite-wal", "~/.domovoi/tls/server.key",
        "~/.domovoi/logs/daemon.log", "~/.domovoi/.hidden", "~/.domovoi/w", "~/.domovoi/worktree", "~/.domovoi/worktreesX",
        "~/.domovoi/worktreesX/file", "~/.domovoi/Worktrees/session-1/a.ts", "~/.domovoi/wx/file", "~/.domovoi/future-secret.json",
        "~/.domovoi/worktrees/session-1/.env", "~/.domovoi/worktrees/session-1/config/id_rsa", "~/.domovoi/worktrees/other/key.pem",
        // Round 2 review: the whole-store deny also hid credential stores a
        // worktree holds at any depth, as a home directory would.
        "~/.domovoi/worktrees/other/.aws/credentials", "~/.domovoi/worktrees/session-1/.ssh/id_ed25519",
        "~/.domovoi/worktrees/session-1/fixtures/.codex/auth.json", "~/.domovoi/worktrees/session-1/.config/gh/hosts.yml",
        "~/.domovoi/worktrees/session-1/.docker/config.json", "~/.domovoi/worktrees/session-1/.claude/.credentials.json",
        "~/.domovoi/worktrees/session-1/.kube/config", "~/.domovoi/worktrees/session-1/.git-credentials",
      ]) expect(refused(path), path).toBe(true)
      // Round 3 review, ruling Q119: every secret file name the card
      // classifier knows is refused in any session worktree, at any depth.
      for (const name of worktreeSecretCopies) {
        const path = `~/.domovoi/worktrees/session-1/${name}`
        expect(namesSecretPath(name), name).toBe(true)
        expect(refused(path), path).toBe(true)
      }
      for (const path of [
        "~/.domovoi/worktrees", "~/.domovoi/worktrees/session-1", "~/.domovoi/worktrees/session-1/src/index.ts",
        "~/.domovoi/worktrees/session-1/walk-gate.txt", "~/.domovoi/worktrees/session-1/src/environment.ts",
        "~/.domovoi/worktrees/session-1/docs/credentials.md", "~/.domovoi/worktrees/session-1/keys/README.md",
        // A project's own .docker and .domovoi directories are ordinary files.
        "~/.domovoi/worktrees/session-1/.docker/Dockerfile", "~/.domovoi/worktrees/session-1/.domovoi/endpoint.json",
      ]) expect(refused(path), path).toBe(false)
    }
  })
})

// One copy per rule of the classifier's secret file names (namesSecretPath),
// as a worktree might hold them, at the top and nested.
const worktreeSecretCopies: readonly string[] = [
  ".domovoi/daemon.token", "daemon.token", "config/credentials.json", "credentials.json", "config/gh/hosts.yml",
  "server.pem", "tls/server.key", "certs/client.p12", "client.pfx",
  "id_rsa", "id_rsa.pub", "config/id_ed25519", "id_ed25519_work", "id_ecdsa", "id_dsa",
  ".env", ".env.local", "app/.envrc", "secrets.env", "prod.env.local", "app.envrc",
  ".netrc", ".npmrc", ".pypirc", ".aws/credentials", ".kube/config", ".docker/config.json", ".ssh/id_ed25519",
]

// Every rule of the card classifier (namesSecretPath), as a worktree might
// hold a name it calls secret: each credential store by its card name, alone,
// as a directory and followed by a character that ends a name; the named
// credential files the same way; a key or certificate extension after any
// stem; a private key where a word starts, with any suffix; and the .env
// family. Not here, and not refused: a name the classifier finds after a
// space, colon, equals sign, quote or backslash inside a longer name
// ("my daemon.token"), which it reads as a command-line separator; a credential
// store's name followed by a non-ASCII symbol (".gnupg😀"), since a glob
// cannot tell a non-ASCII symbol from a letter; and compatibility forms that
// only its Unicode folding joins, such as a fullwidth letter.
const classifierSecretSamples: readonly string[] = [
  ...credentialStores.flatMap(({ location, cardName }) => {
    const name = cardName ?? location.slice(2)
    return [name, `${name}/inner`, `${name}~`, `${name} (1)/inner`]
  }),
  "daemon.token", "daemon.token~", "credentials.json", "credentials.json (1)", "gh/hosts.yml", "config/gh/hosts.yml",
  "gh/hosts.yml#", "daemon.token/inner",
  "server.pem", ".pem", "tls/server.key", "certs/client.p12", "client.pfx", "server.pem~", "x.key/inner",
  "id_rsa", "id_rsa.pub", "id_ed25519_work", "id_ecdsa", "id_dsa", "backup-id_ed25519", "keys/old.id_dsa",
  "my id_rsa", "x.id_ecdsa.pub", "id_rsa.d/inner", "2024-id_ed25519",
  ".env", ".env.local", ".envrc", ".environment", "app/.envrc", "secrets.env", "prod.env.local", "app.envrc",
  "x.env~", "app.envrc (1)", ".env/inner", "config.env.ts", "x.env.d/inner",
  // The classifier's ASCII reading (#545's list) ends these names at any
  // character outside [A-Za-z0-9_.-], a letter such as é included.
  "daemon.tokené", "credentials.jsonü", ".sshé/inner", ".netrcé", "server.pemé", "x.envé",
  "daemon.token,old", ".gnupg,old", "x.env,old",
  // A control character ends a name under both readings.
  ".azure\tx", ".gnupg\u007f/data", ".kube\u0001", "daemon.token\t", "server.pem\u007f",
]

// Project files that are not secrets, and names that only resemble one.
const ordinaryProjectFiles: readonly string[] = [
  "src/environment.ts", "docs/credentials.md", "keys/README.md", ".docker/Dockerfile", ".domovoi/endpoint.json",
  "readme.txt", "walk-gate.txt", "src/invalid_rsa.go", "src/hotkey.keymap.ts", "server.pem.bak", "credentials.json.bak",
  "old.credentials.json", "my-credentials.json", "config/gh/other.yml", ".sshrc", ".aws-sam/build.toml", "x.env-prod",
  "app.envrc.bak", "daemon.token.old", "valid_rsa.go",
  // #867 review: the classifier reads a credential store's name as going on
  // through any letter, digit or mark, so these are not secret, and neither is
  // a store name followed by a hyphen.
  ".azureé", ".gnupgé/key.txt", "Library/Keychainsé/login", ".config/gcloud日本/x", ".azure-x", ".kubeé/config.yml",
]

// A name in lower, upper and mixed letter case.
function letterCases(name: string): string[] {
  let upper = false
  const mixed = [...name].map((character) => {
    if (!/\p{L}/u.test(character)) return character
    upper = !upper
    return upper ? character.toUpperCase() : character.toLowerCase()
  }).join("")
  return [...new Set([name, name.toUpperCase(), mixed])]
}

function filesystemTable(platform: NodeJS.Platform, profile: string): Record<string, Record<string, string> | string> & {
  ":workspace_roots"?: Record<string, string>
} {
  const value = codexAppServerArguments(platform).find((setting) => setting.startsWith(`permissions.${profile}.filesystem=`))!
  return parseToml(`filesystem = ${value.slice(value.indexOf("=") + 1)}`).filesystem as Record<string, Record<string, string> | string>
}

// The glob forms the profile uses, as codex-cli 0.162.1 applies them (its
// Seatbelt translation, the ripgrep scan on Linux and Windows, and its own
// read checks): * and ? stay within one name and match a leading dot, [c] is
// one of the characters c and [!c] any other, {a,b} is either branch, and **
// is any depth. Letter case counts unless ignoresCase; a class never matches a
// slash unless classMatchesSlash, as in Seatbelt's regex.
type GlobOptions = { ignoresCase?: boolean; classMatchesSlash?: boolean }

function globMatches(pattern: string, path: string, options: GlobOptions = {}): boolean {
  return globRegExp(pattern, options).test(path)
}

function globRegExp(pattern: string, options: GlobOptions): RegExp {
  let source = ""
  let braces = 0
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (pattern.startsWith("**/", index)) {
      source += "(?:[^/]*/)*"
      index += 2
    } else if (pattern.startsWith("**", index)) {
      source += ".*"
      index += 1
    } else if (character === "*") source += "[^/]*"
    else if (character === "?") source += "[^/]"
    else if (character === "{") {
      braces += 1
      source += "(?:"
    } else if (character === "}" && braces > 0) {
      braces -= 1
      source += ")"
    } else if (character === "," && braces > 0) source += "|"
    else if (character === "[") {
      const end = pattern.indexOf("]", index + 1)
      const negated = pattern[index + 1] === "!"
      const members = pattern.slice(index + (negated ? 2 : 1), end).replace(/[\\\]^]/gu, String.raw`\$&`)
      source += negated ? `[^${options.classMatchesSlash ? "" : "/"}${members}]` : `[${members}]`
      index = end
    } else source += character.replace(/[.+^$()|[\]\\]/gu, String.raw`\$&`)
  }
  return new RegExp(`^${source}$`, options.ignoresCase ? "iu" : "u")
}

// An absolute path Seatbelt writes in length bytes, in names of about
// component bytes, with every other character a hyphen if hyphens.
function worktreePath(length: number, component: number, hyphens = false): string {
  const name = (size: number) => [...Array(size).keys()].map((index) => hyphens && index % 2 === 1 ? "-" : "x").join("")
  const written = (path: string) => seatbeltRegex(path, false).length - 2
  let path = "/Users"
  while (written(`${path}/${name(component)}`) + 2 < length) path += `/${name(component)}`
  return `${path}/${"y".repeat(length - written(path) - 1)}`
}

// The regex codex-cli 0.162.1 writes for a glob in a Seatbelt profile
// (seatbelt_regex_for_glob in sandboxing/src/seatbelt.rs).
function seatbeltRegex(pattern: string, subtree: boolean): string {
  const escaped = new Set([..."\\.+*?()|[]{}^$#&-~"])
  const characters = [...pattern]
  let regex = "^"
  let braces = 0
  let sawGlob = false
  while (characters.length > 0) {
    const character = characters.shift()!
    if (character === "*") {
      sawGlob = true
      if (characters[0] !== "*") regex += "[^/]*"
      else {
        characters.shift()
        if (characters.at(0) === "/") {
          characters.shift()
          regex += "(.*/)?"
        } else regex += ".*"
      }
    } else if (character === "?") {
      sawGlob = true
      regex += "[^/]"
    } else if (character === "{") {
      sawGlob = true
      braces += 1
      regex += "("
    } else if (character === "}" && braces > 0) {
      braces -= 1
      regex += ")"
    } else if (character === "," && braces > 0) regex += "|"
    else if (character === "[" && characters.includes("]")) {
      sawGlob = true
      const members = characters.splice(0, characters.indexOf("]") + 1).slice(0, -1).join("")
      regex += `[${members.startsWith("!") ? `^${members.slice(1)}` : members}]`
    } else regex += escaped.has(character) ? `\\${character}` : character
  }
  regex += ")".repeat(braces)
  return `${regex}${!sawGlob && subtree ? "(/.*)?" : ""}$`
}

// The bytes of the deny rules codex-cli 0.162.1 writes into a Seatbelt profile
// for these absolute globs, and its longest regex
// (build_seatbelt_unreadable_glob_policy): a read and a write rule per glob,
// and a rule per ancestor directory of a glob that is not a plain name at any
// depth.
function seatbeltGlobPolicy(globs: readonly string[]): { bytes: number; longestRegex: number } {
  let bytes = 0
  let longestRegex = 0
  for (const glob of globs) {
    const name = glob.startsWith("/**/") ? glob.slice(4) : undefined
    const plainName = name !== undefined && ![".", ".."].includes(name) && /^[^/*?[\]{}\\]+$/u.test(name)
    const regex = plainName ? `${seatbeltRegex(glob, true).slice(0, -1)}(/.*)?$` : seatbeltRegex(glob, true)
    longestRegex = Math.max(longestRegex, Buffer.byteLength(regex))
    bytes += 2 * Buffer.byteLength(`(deny file-read* (regex #"${regex}"))\n`)
    if (plainName) continue
    for (let ancestor = glob.slice(0, glob.lastIndexOf("/")); ; ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"))) {
      const directory = ancestor === "" ? "/" : ancestor
      bytes += Buffer.byteLength(`(deny file-write-unlink (require-all (vnode-type DIRECTORY) (regex #"${seatbeltRegex(directory, false)}")))\n`)
      if (ancestor === "") break
    }
  }
  return { bytes, longestRegex }
}

describe("codexSandboxNotice", () => {
  it("names committed files Codex can still read through Git", () => {
    expect(codexSandboxNotice([".env.example", "certs/dev.pem"]).detail).toBe(
      `${codexWorktreeSecretNotice.detail} Codex can still read these through Git: .env.example and certs/dev.pem.`,
    )
    expect(codexSandboxNotice([".env"]).detail).toBe(`${codexWorktreeSecretNotice.detail} Codex can still read these through Git: .env.`)
    expect(codexSandboxNotice([])).toEqual(codexWorktreeSecretNotice)
  })

  it("says so when the repository history could not be checked", () => {
    expect(codexSandboxNotice(undefined).detail).toBe(
      `${codexWorktreeSecretNotice.detail} Domovoi could not finish checking the repository history.`,
    )
  })
})

describe("StdioCodexTransport", () => {
  // Security review round 3: Codex reads its environments once, when the
  // app-server starts, from the variables and Codex home it is started with.
  describe("local environment verdict", () => {
    const homes: string[] = []
    afterEach(() => {
      for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
    })
    const cleanHome = () => {
      const path = mkdtempSync(join(tmpdir(), "domovoi-codex-launch-"))
      homes.push(path)
      return path
    }

    it("starts the app-server with the variables it judged", () => {
      const child = new FakeChild()
      const env = { CODEX_HOME: cleanHome(), PATH: "/usr/bin" }
      const factory = vi.fn((_env: NodeJS.ProcessEnv) => child as unknown as ChildProcessWithoutNullStreams)
      const transport = new StdioCodexTransport(factory, 2_000, { env, cwd: tmpdir(), homeCandidates: [], platform: process.platform })
      expect(factory).toHaveBeenCalledWith(env)
      expect(transport.environmentIsLocalOnly()).toBe(true)
    })

    it("keeps a verdict taken before the start once the environments file goes away", () => {
      const home = cleanHome()
      writeFileSync(join(home, "environments.toml"), 'default = "build"\n')
      const transport = new StdioCodexTransport(() => {
        rmSync(join(home, "environments.toml"))
        return new FakeChild() as unknown as ChildProcessWithoutNullStreams
      }, 2_000, { env: { CODEX_HOME: home }, cwd: tmpdir(), homeCandidates: [], platform: process.platform })
      expect(transport.environmentIsLocalOnly()).toBe(false)
    })

    it("never goes back to local for the life of the app-server", () => {
      const home = cleanHome()
      const transport = new StdioCodexTransport(
        () => new FakeChild() as unknown as ChildProcessWithoutNullStreams,
        2_000,
        { env: { CODEX_HOME: home }, cwd: tmpdir(), homeCandidates: [], platform: process.platform },
      )
      expect(transport.environmentIsLocalOnly()).toBe(true)
      writeFileSync(join(home, "environments.toml"), 'default = "build"\n')
      expect(transport.environmentIsLocalOnly()).toBe(false)
      rmSync(join(home, "environments.toml"))
      expect(transport.environmentIsLocalOnly()).toBe(false)
    })
  })

  it("drains child stderr to prevent pipe backpressure", () => {
    const child = new FakeChild()

    new StdioCodexTransport(() => child as unknown as ChildProcessWithoutNullStreams)

    expect(child.stderr.readableFlowing).toBe(true)
  })

  it("reports an unexpected child exit once", () => {
    const child = new FakeChild()
    const transport = new StdioCodexTransport(
      () => child as unknown as ChildProcessWithoutNullStreams,
    )
    const error = vi.fn()
    transport.onError(error)

    child.emit("exit", 1, null)
    child.emit("close", 1, null)
    child.emit("error", new Error("late process error"))

    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      message: "Codex app-server exited with code 1",
    }))
  })

  it("carries the child's final stderr into the exit error", async () => {
    const child = new FakeChild()
    const transport = new StdioCodexTransport(
      () => child as unknown as ChildProcessWithoutNullStreams,
    )
    const error = vi.fn()
    transport.onError(error)

    child.stderr.write("token=super-secret\nNot logged in\n")
    await new Promise((resolve) => setImmediate(resolve))
    child.emit("exit", 1, null)
    child.emit("close", 1, null)

    expect(error).toHaveBeenCalledTimes(1)
    const message = (error.mock.calls[0]?.[0] as Error).message
    expect(message).toBe("Codex app-server exited with code 1: token=[REDACTED]\nNot logged in")
    expect(classifyProviderFailure(new Error(message)).kind).toBe("authentication-expired")
  })

  it.runIf(process.platform !== "win32")("keeps the sign-in reason when a real child ends on a partial stdout line", async () => {
    for (let run = 0; run < 20; run += 1) {
      const transport = new StdioCodexTransport(() => spawn(
        "sh",
        ["-c", "printf 'Error: boom'; echo 'Not logged in' >&2; exit 1"],
        { stdio: ["pipe", "pipe", "pipe"] },
      ))
      const failure = new Promise<Error>((resolve) => transport.onError(resolve))
      const message = (await failure).message

      expect(message, `run ${run}`).toBe("Codex app-server exited with code 1: Not logged in")
      expect(classifyProviderFailure(new Error(message)).kind).toBe("authentication-expired")
      await transport.close()
    }
  })

  it("keeps the exit reason over malformed output an inherited pipe delivers after the exit", async () => {
    const child = new FakeChild()
    const transport = new StdioCodexTransport(
      () => child as unknown as ChildProcessWithoutNullStreams,
    )
    const error = vi.fn()
    transport.onError(error)

    child.stderr.write("Not logged in\n")
    await new Promise((resolve) => setImmediate(resolve))
    child.emit("exit", 1, null)
    child.stdout.write("not json from a grandchild\n")
    await new Promise((resolve) => setImmediate(resolve))
    child.emit("close", 1, null)

    expect(error).toHaveBeenCalledTimes(1)
    expect((error.mock.calls[0]?.[0] as Error).message).toBe("Codex app-server exited with code 1: Not logged in")
  })

  it.runIf(process.platform !== "win32")("keeps the sign-in reason when a background process writes a malformed line after the exit", async () => {
    for (let run = 0; run < 5; run += 1) {
      const transport = new StdioCodexTransport(() => spawn(
        "sh",
        ["-c", "(sleep 0.1; echo 'not json') & echo 'Not logged in' >&2; exit 1"],
        { stdio: ["pipe", "pipe", "pipe"] },
      ))
      const failure = new Promise<Error>((resolve) => transport.onError(resolve))
      const message = (await failure).message

      expect(message, `run ${run}`).toBe("Codex app-server exited with code 1: Not logged in")
      await transport.close()
    }
  })

  it("reads stderr that arrives after the exit and before the streams close", async () => {
    const child = new FakeChild()
    const transport = new StdioCodexTransport(
      () => child as unknown as ChildProcessWithoutNullStreams,
    )
    const error = vi.fn()
    transport.onError(error)

    child.emit("exit", 1, null)
    child.stderr.write("Not logged in\n")
    await new Promise((resolve) => setImmediate(resolve))
    child.emit("close", 1, null)

    expect(error).toHaveBeenCalledTimes(1)
    expect((error.mock.calls[0]?.[0] as Error).message).toBe("Codex app-server exited with code 1: Not logged in")
  })

  it("still reports an exit whose streams a grandchild keeps open", async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const transport = new StdioCodexTransport(
        () => child as unknown as ChildProcessWithoutNullStreams,
      )
      const error = vi.fn()
      transport.onError(error)

      child.emit("exit", 1, null)
      expect(error).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)

      expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: "Codex app-server exited with code 1" }))
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps only the last 16 KiB of stderr in the exit error", async () => {
    const child = new FakeChild()
    const transport = new StdioCodexTransport(
      () => child as unknown as ChildProcessWithoutNullStreams,
    )
    const error = vi.fn()
    transport.onError(error)

    child.stderr.write(`${"x".repeat(20_000)}\n`)
    child.stderr.write("Not logged in\n")
    await new Promise((resolve) => setImmediate(resolve))
    child.emit("exit", null, "SIGABRT")
    child.emit("close", null, "SIGABRT")

    const message = (error.mock.calls[0]?.[0] as Error).message
    expect(message.startsWith("Codex app-server exited from signal SIGABRT: ")).toBe(true)
    expect(message.endsWith("Not logged in")).toBe(true)
    expect(message.length).toBeLessThanOrEqual(16_384 + "Codex app-server exited from signal SIGABRT: ".length)
  })

  it("does not report an intentional child exit", async () => {
    const child = new FakeChild()
    const transport = new StdioCodexTransport(
      () => child as unknown as ChildProcessWithoutNullStreams,
    )
    const error = vi.fn()
    transport.onError(error)

    await transport.close()

    expect(error).not.toHaveBeenCalled()
  })

  // A JSON-RPC id may be a string (RequestId in the 0.162.1 schema). Dropped,
  // a request with one would wait unanswered and unseen.
  it("keeps a string request id from the app-server", async () => {
    const child = new FakeChild()
    const transport = new StdioCodexTransport(
      () => child as unknown as ChildProcessWithoutNullStreams,
    )
    const message = vi.fn()
    transport.onMessage(message)

    child.stdout.write(`${JSON.stringify({ id: "approval-85", method: "item/fileChange/requestApproval", params: { threadId: "thread-1" } })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(message).toHaveBeenCalledWith({ id: "approval-85", method: "item/fileChange/requestApproval", params: { threadId: "thread-1" } })
    await transport.close()
  })

  it("narrows app-server lines to JSON-RPC messages and rejects non-object lines", async () => {
    const child = new FakeChild()
    const transport = new StdioCodexTransport(
      () => child as unknown as ChildProcessWithoutNullStreams,
    )
    const message = vi.fn()
    const error = vi.fn()
    transport.onMessage(message)
    transport.onError(error)

    child.stdout.write(`${JSON.stringify({
      id: 2,
      method: 5,
      params: "not-an-object",
      result: { ok: true },
    })}\n`)
    child.stdout.write("[]\n")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(message).toHaveBeenCalledTimes(1)
    expect(message).toHaveBeenCalledWith({ id: 2, result: { ok: true } })
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      message: "Codex app-server emitted invalid JSONL",
    }))
  })

  it("escalates a stuck close and resolves after the grace period", async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      child.ignoreSignals = true
      const transport = new StdioCodexTransport(
        () => child as unknown as ChildProcessWithoutNullStreams,
        25,
      )

      const closing = transport.close()
      expect(child.signals).toEqual(["SIGTERM"])
      await vi.advanceTimersByTimeAsync(25)
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"])
      // A child that outlives its kill still bounds the close.
      await vi.advanceTimersByTimeAsync(25)

      await expect(closing).resolves.toBeUndefined()
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports the close only once the killed child has exited", async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      child.ignoreSignals = true
      const transport = new StdioCodexTransport(
        () => child as unknown as ChildProcessWithoutNullStreams,
        25,
      )
      const settled = vi.fn()

      const closing = transport.close().then(settled)
      await vi.advanceTimersByTimeAsync(25)

      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"])
      expect(settled).not.toHaveBeenCalled()

      child.signalCode = "SIGKILL"
      child.emit("exit", null, "SIGKILL")
      child.emit("close", null, "SIGKILL")
      await closing

      expect(settled).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("CodexAppServerAdapter permissions", () => {
  it("declares read-only Ask and rejects unenforceable Build-auto", () => {
    expect(new CodexAppServerAdapter(() => new FakeTransport()).permissionCapabilities).toEqual({
      ask: "read-only",
      buildAuto: "unsupported",
    })
  })
})

describe("CodexAppServerAdapter", () => {
  it("initializes without experimental APIs when capability negotiation is unavailable", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()

    transport.receive({ id: 1, error: { message: "unknown capability experimentalApi" } })
    await Promise.resolve()
    expect(transport.sent[1]).toMatchObject({
      id: 2,
      method: "initialize",
      params: { clientInfo: { name: "domovoi", title: "Domovoi", version: "9.8.7-test" } },
    })
    expect(transport.sent[1]?.params).not.toHaveProperty("capabilities")
    transport.receive({ id: 2, result: {} })

    await expect(connecting).resolves.toBeUndefined()
    expect(transport.sent[2]).toEqual({ method: "initialized", params: {} })
    await adapter.close()
  })

  it("reads provider-reported primary and secondary quota windows", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const reading = adapter.usageLimits()
    expect(transport.sent.at(-1)).toEqual({
      id: 2,
      method: "account/rateLimits/read",
      params: { excludeResetCreditDetails: true },
    })
    transport.receive({
      id: 2,
      result: {
        rateLimits: {
          planType: "plus",
          primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1_758_405_600 },
          secondary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: 1_758_751_200 },
        },
      },
    })

    await expect(reading).resolves.toEqual({
      provider: "codex",
      planType: "plus",
      windows: [
        { kind: "primary", usedPercent: 23, windowDurationMinutes: 300, resetsAt: "2025-09-20T22:00:00.000Z" },
        { kind: "secondary", usedPercent: 41, windowDurationMinutes: 10_080, resetsAt: "2025-09-24T22:00:00.000Z" },
      ],
    })
    await adapter.close()
  })

  it("omits absent or malformed quota windows", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const reading = adapter.usageLimits()
    transport.receive({
      id: 2,
      result: {
        rateLimits: {
          planType: "plus",
          primary: null,
          secondary: { usedPercent: -1, windowDurationMins: 10_080, resetsAt: 1_758_751_200 },
        },
      },
    })

    await expect(reading).resolves.toBeUndefined()
    await adapter.close()
  })

  it("resets timed-out initialization without reviving the stale transport", async () => {
    const first = new FakeTransport()
    const second = new FakeTransport()
    const transports = [first, second]
    const adapter = new CodexAppServerAdapter(() => transports.shift()!)

    const staleConnection = adapter.connect()
    await adapter.resetConnection()
    await expect(staleConnection).rejects.toThrow("Codex connection reset")
    expect(first.closeCount).toBe(1)

    const freshConnection = adapter.connect()
    first.receiveStale({ id: 1, result: {} })
    expect(first.sent).not.toContainEqual(expect.objectContaining({ method: "initialized" }))
    second.receive({ id: 2, result: {} })
    await expect(freshConnection).resolves.toBeUndefined()
    expect(second.sent).toContainEqual(expect.objectContaining({ method: "initialized" }))
    await adapter.close()
  })

  it("rejects in-flight work and reconnects after transport loss", async () => {
    const first = new FakeTransport()
    const second = new FakeTransport()
    const transports = [first, second]
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transports.shift()!)
    adapter.onEvent(event)
    const connecting = adapter.connect()
    first.receive({ id: 1, result: {} })
    await connecting

    const interrupted = adapter.startTurn({
      threadId: "thread-recover",
      cwd: "/worktree",
      prompt: "Run tests",
      runtime: runtime("build", false),
    })
    await vi.waitFor(() => expect(first.sent[2]).toBeDefined(), { timeout: 5_000 })
    first.fail(new Error("Codex app-server exited with code 1"))

    await expect(interrupted).rejects.toThrow("Codex app-server exited with code 1")
    expect(event).toHaveBeenCalledWith({
      type: "provider-disconnected",
      reason: "Codex app-server exited with code 1",
    })

    const reconnecting = adapter.connect()
    expect(second.sent[0]).toMatchObject({ id: 3, method: "initialize" })
    second.receive({ id: 3, result: {} })
    await reconnecting
    const resuming = adapter.resumeThread({
      threadId: "thread-recover",
      cwd: "/worktree",
      runtime: runtime("build", false),
    })
    expect(second.sent.at(-1)).toMatchObject({
      id: 4,
      method: "thread/resume",
      params: { threadId: "thread-recover" },
    })
    second.receive({ id: 4, result: { thread: { id: "thread-recover" } } })
    await resuming

    event.mockClear()
    first.receiveStale({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-recover", turnId: "turn-old", delta: "stale" },
    })
    first.failStale(new Error("late stale failure"))
    expect(event).not.toHaveBeenCalled()

    await adapter.close()
  })

  // Slice P6c: a trusted repository's server reaches Codex made to ask before
  // each tool, its call raises a card like any tool server's, and the thread
  // is reported as given trusted servers until the app-server that holds it
  // is gone.
  it("passes a trusted repository's server, raises a card for its call, and forgets the thread with its transport", async () => {
    const transport = new FakeTransport()
    const digest = `sha256:${"e".repeat(64)}`
    const read = vi.fn(async () => ({
      configDigest: digest, providers: [], trustRefusals: [],
      documents: { ".codex/config.toml": { approval_policy: "never", mcp_servers: { db: { command: "db-mcp", default_tools_approval_mode: "approve" } } } },
    }))
    transport.environmentIsLocalOnly = () => true
    const adapter = new CodexAppServerAdapter(() => transport, read)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({
      cwd: "/worktree",
      runtime: runtime("build", false),
      repositoryTrust: { projectId: "project-acme", trustedDigest: digest, trustedAt: "2026-09-29T12:00:00.000Z", trustedBy: { client: "desktop" } },
    })
    await vi.waitFor(
      () => expect(transport.sent.at(-1)).toMatchObject({ method: "config/read", params: { cwd: "/worktree", includeLayers: true } }),
      { timeout: 5_000 },
    )
    transport.receive({ id: transport.sent.at(-1)!.id!, result: { config: {}, layers: [{ name: { type: "user", file: "/home/person/.codex/config.toml" }, version: "1", config: {} }] } })
    await vi.waitFor(
      () => expect(transport.sent.at(-1)).toMatchObject({ method: "mcpServerStatus/list", params: { detail: "toolsAndAuthOnly" } }),
      { timeout: 5_000 },
    )
    transport.receive({ id: transport.sent.at(-1)!.id!, result: { data: [{ name: "github", pluginId: "github@curated" }], nextCursor: null } })
    await vi.waitFor(() => expect(transport.sent.at(-1)?.method).toBe("thread/start"), { timeout: 5_000 })
    expect(transport.sent.at(-1)?.params?.config).toMatchObject({
      mcp_servers: { db: { command: "db-mcp", default_tools_approval_mode: "prompt" } },
      approvals_reviewer: "user",
      features: { tool_call_mcp_elicitation: true },
    })
    expect(transport.sent.at(-1)?.params?.config).not.toHaveProperty("approval_policy")
    transport.receive({ id: transport.sent.at(-1)!.id!, result: { thread: { id: "thread-1" } } })
    expect(await starting).toBe("thread-1")
    expect(adapter.repositoryTrustApplied("thread-1")).toEqual({ digest })

    transport.receive({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: { type: "mcpToolCall", id: "call-1", server: "db", tool: "query", arguments: {} } },
    })
    transport.receive({
      id: 90,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1", turnId: "turn-1", serverName: "db", mode: "form", message: "Allow query?",
        requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call" },
      },
    })
    expect(events).toContainEqual(expect.objectContaining({ type: "approval-requested", requestId: 90, toolServer: { name: "db" }, tool: "db.query" }))

    transport.fail(new Error("Codex app-server exited with code 1"))
    expect(adapter.repositoryTrustApplied("thread-1")).toBeUndefined()
  })

  it("shares initialization across concurrent connect calls", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)

    const first = adapter.connect()
    const second = adapter.connect()
    let secondSettled = false
    void second.finally(() => { secondSettled = true })
    await Promise.resolve()

    expect(transport.sent.filter((message) => message.method === "initialize")).toHaveLength(1)
    expect(secondSettled).toBe(false)
    transport.receive({ id: 1, result: {} })
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    await adapter.close()
  })

  it("rejects every pending request and reports transport loss once", async () => {
    const transport = new FakeTransport()
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const listing = adapter.listModels()
    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("build", false) })
    const failure = new Error("Codex transport failed")
    transport.fail(failure)
    transport.fail(failure)

    await expect(listing).rejects.toThrow("Codex transport failed")
    await expect(starting).rejects.toThrow("Codex transport failed")
    expect(event).toHaveBeenCalledTimes(1)
    expect(event).toHaveBeenCalledWith({
      type: "provider-disconnected",
      reason: "Codex transport failed",
    })
    expect(transport.closeCount).toBe(1)
  })

  it("cancels discovery without closing a shared transport or following a late page", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting
    const controller = new AbortController()
    const listing = adapter.listModels(controller.signal)
    controller.abort(new Error("Discovery expired"))
    await expect(listing).rejects.toThrow("Discovery expired")
    transport.receive({ id: 2, result: { data: [], nextCursor: "late-page" } })
    expect(transport.sent.filter(({ method }) => method === "model/list")).toHaveLength(1)
    expect(transport.closeCount).toBe(0)
    const retry = adapter.listModels()
    transport.receive({ id: 3, result: { data: [], nextCursor: null } })
    await expect(retry).resolves.toEqual([])
    await adapter.close()
  })

  it("cleans up a failed initialization and permits another connect", async () => {
    const first = new FakeTransport()
    const second = new FakeTransport()
    const transports = [first, second]
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transports.shift()!)
    adapter.onEvent(event)

    const failedConnect = adapter.connect()
    first.receive({ id: 1, error: { message: "Unsupported protocol" } })
    await expect(failedConnect).rejects.toThrow("Unsupported protocol")
    expect(first.closeCount).toBe(1)
    expect(event).not.toHaveBeenCalled()

    const reconnecting = adapter.connect()
    expect(second.sent[0]).toMatchObject({ id: 2, method: "initialize" })
    second.receive({ id: 2, result: {} })
    await expect(reconnecting).resolves.toBeUndefined()
    await adapter.close()
  })

  it("cleans up when the initialized notification cannot be sent", async () => {
    const first = new FakeTransport()
    first.throwOnMethod = "initialized"
    const second = new FakeTransport()
    const transports = [first, second]
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transports.shift()!)
    adapter.onEvent(event)

    const failedConnect = adapter.connect()
    first.receive({ id: 1, result: {} })
    await expect(failedConnect).rejects.toThrow("Failed to send initialized")
    expect(first.closeCount).toBe(1)
    expect(event).not.toHaveBeenCalled()

    const reconnecting = adapter.connect()
    second.receive({ id: 2, result: {} })
    await expect(reconnecting).resolves.toBeUndefined()
    await adapter.close()
  })

  it("detaches and rejects initialization before waiting for close", async () => {
    const transport = new FakeTransport()
    let releaseClose!: () => void
    transport.closeGate = new Promise<void>((resolve) => { releaseClose = resolve })
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)

    const connecting = adapter.connect()
    const closing = adapter.close()

    await expect(connecting).rejects.toThrow("Codex adapter closed")
    expect(event).not.toHaveBeenCalled()
    transport.failStale(new Error("late failure while closing"))
    expect(event).not.toHaveBeenCalled()
    releaseClose()
    await expect(closing).resolves.toBeUndefined()
  })

  it("does not report intentional close as transport loss", async () => {
    const transport = new FakeTransport()
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const pending = adapter.listModels()
    await adapter.close()

    await expect(pending).rejects.toThrow("Codex adapter closed")
    expect(event).not.toHaveBeenCalled()
    expect(transport.closeCount).toBe(1)
  })

  it("resumes a persisted thread before another turn", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const resuming = adapter.resumeThread({
      threadId: "thread-restored",
      cwd: "/worktree",
      runtime: runtime("build", false),
    })
    expect(transport.sent[2]).toMatchObject({
      id: 2,
      method: "thread/resume",
      params: { threadId: "thread-restored" },
    })
    transport.receive({ id: 2, result: { thread: { id: "thread-restored" } } })
    await expect(resuming).resolves.toBeUndefined()
    await adapter.close()
  })

  // Codex made update_plan opt-in (openai/codex a9519cbcdd, #41744): at
  // rust-v0.160.1 the tool is registered only when tools.update_plan.enabled
  // is true. Measured 2026-10-07 with codex-cli 0.160.1: without it the model
  // reported no update_plan tool and no turn/plan/updated arrived; with it in
  // the thread config, Codex called update_plan and sent turn/plan/updated.
  it("turns on Codex's update_plan tool for every thread it starts or resumes", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("build", false) })
    transport.receive({ id: 2, result: { config: {}, origins: {} } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[3]).toMatchObject({
      method: "thread/start",
      params: { config: { tools: { update_plan: { enabled: true } } } },
    })
    transport.receive({ id: 3, result: { thread: { id: "thread-planned" } } })
    await expect(starting).resolves.toBe("thread-planned")

    const resuming = adapter.resumeThread({ threadId: "thread-restored", cwd: "/worktree", runtime: runtime("build", false) })
    await vi.waitFor(() => expect(transport.sent[4]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[4]).toMatchObject({
      method: "thread/resume",
      params: { threadId: "thread-restored", config: { tools: { update_plan: { enabled: true } } } },
    })
    transport.receive({ id: 4, result: { thread: { id: "thread-restored" } } })
    await expect(resuming).resolves.toBeUndefined()
    await adapter.close()
  })

  it("lists visible models from the installed Codex app server", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const listing = adapter.listModels()
    expect(transport.sent[2]).toMatchObject({
      id: 2,
      method: "model/list",
      params: { includeHidden: false, limit: 100 },
    })
    transport.receive({
      id: 2,
      result: {
        data: [{
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          description: "Coding model",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "none", description: "No reasoning" },
            { reasoningEffort: "medium", description: "Balanced" },
            { reasoningEffort: "xhigh", description: "Deeper" },
            { reasoningEffort: "max", description: "Maximum" },
          ],
          defaultReasoningEffort: "xhigh",
          isDefault: true,
        }],
        nextCursor: null,
      },
    })

    await expect(listing).resolves.toEqual([{
      provider: "codex",
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "Coding model",
      supportedReasoningEfforts: ["none", "medium", "xhigh", "max"],
      defaultReasoningEffort: "xhigh",
      isDefault: true,
    }])
    await adapter.close()
  })

  it("normalizes reasoning defaults and stops repeated pagination cursors", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const listing = adapter.listModels()
    transport.receive({
      id: 2,
      result: {
        data: [{
          model: "model-a",
          supportedReasoningEfforts: [
            { reasoningEffort: " low " },
            { reasoningEffort: "   " },
          ],
          defaultReasoningEffort: " high ",
        }],
        nextCursor: "repeat",
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(transport.sent.at(-1)).toMatchObject({
      id: 3,
      method: "model/list",
      params: { cursor: "repeat" },
    })
    transport.receive({
      id: 3,
      result: { data: [], nextCursor: "repeat" },
    })

    await expect(listing).resolves.toEqual([
      expect.objectContaining({
        id: "model-a",
        displayName: "model-a",
        supportedReasoningEfforts: ["high", "low"],
        defaultReasoningEffort: "high",
      }),
    ])
    expect(transport.sent.filter((message) => message.method === "model/list")).toHaveLength(2)
    await adapter.close()
  })

  it("skips malformed model rows instead of failing the whole listing", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const listing = adapter.listModels()
    transport.receive({
      id: 2,
      result: {
        data: [
          { model: 5, displayName: "Numeric id" },
          { model: "bad-display", displayName: 7 },
          { model: "bad-effort", defaultReasoningEffort: 3 },
          { model: "bad-efforts", supportedReasoningEfforts: [null] },
          { model: "bad-flag", isDefault: "yes" },
          {
            model: "good",
            displayName: "Good",
            description: "Kept",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            defaultReasoningEffort: "high",
            isDefault: false,
          },
        ],
        nextCursor: null,
      },
    })

    await expect(listing).resolves.toEqual([{
      provider: "codex",
      id: "good",
      displayName: "Good",
      description: "Kept",
      supportedReasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
      isDefault: false,
    }])
    await adapter.close()
  })

  it("rejects thread and turn results without string identifiers", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("build", false) })
    transport.receive({ id: 2, result: { config: {}, origins: {} } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined(), { timeout: 5_000 })
    transport.receive({ id: 3, result: { thread: { id: 7 } } })
    await expect(starting).rejects.toThrow("Codex did not return a thread id")

    const turning = adapter.startTurn({
      threadId: "thread-1",
      cwd: "/worktree",
      prompt: "Run the tests",
      runtime: runtime("build", false),
    })
    await vi.waitFor(() => expect(transport.sent[4]).toBeDefined(), { timeout: 5_000 })
    transport.receive({ id: 4, result: { turn: { id: ["turn-1"] } } })
    await expect(turning).rejects.toThrow("Codex did not return a turn id")

    const resuming = adapter.resumeThread({
      threadId: "7",
      cwd: "/worktree",
      runtime: runtime("build", false),
    })
    transport.receive({ id: 5, result: null })
    await expect(resuming).rejects.toThrow("Codex did not resume the requested thread")

    const steering = adapter.steerTurn("thread-1", "turn-1", "Focus on the failing test")
    transport.receive({ id: 6, result: "turn-1" })
    await expect(steering).rejects.toThrow("Codex steered a different turn")
    await adapter.close()
  })

  it("translates plan mode to the Codex read-only sandbox", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)

    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("plan", false) })
    transport.receive({ id: 2, result: { config: {}, origins: {} } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[3]).toMatchObject({
      id: 3,
      method: "thread/start",
      params: { sandbox: "read-only" },
    })
    transport.receive({ id: 3, result: { thread: { id: "thread-plan" } } })
    await expect(starting).resolves.toBe("thread-plan")
    await adapter.close()
  })

  it.each([
    ["the person's own instructions", "Always answer in French.", "Always answer in French.\n\n"],
    ["no instructions of their own", null, ""],
  ] as const)("adds Domovoi's text to %s, read from Codex's resolved config for the worktree", async (_label, own, prefix) => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("build", false) })
    expect(transport.sent[2]).toEqual({ id: 2, method: "config/read", params: { cwd: "/worktree" } })
    transport.receive({ id: 2, result: { config: { developer_instructions: own }, origins: {} } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[3]).toMatchObject({
      id: 3,
      method: "thread/start",
      params: { developerInstructions: `${prefix}${codexDeveloperInstructions}` },
    })
    transport.receive({ id: 3, result: { thread: { id: "thread-own" } } })
    await expect(starting).resolves.toBe("thread-own")
    await adapter.close()
  })

  it("does not start a Codex thread without the person's own instructions when they cannot be read", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("build", false) })
    transport.receive({ id: 2, error: { code: -32600, message: "config read failed" } })
    await expect(starting).rejects.toThrow("config read failed")
    expect(transport.sent.map((message) => message.method)).not.toContain("thread/start")
    await adapter.close()
  })

  it.each([
    ["ask", false],
    ["plan", false],
    ["build", false],
    ["build", true],
  ] as const)("tells a new %s Codex thread which worktree files its sandbox refuses", async (mode, auto) => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)

    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime(mode, auto) })
    transport.receive({ id: 2, result: { config: {}, origins: {} } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined(), { timeout: 5_000 })
    const instructions = (transport.sent[3]?.params as { developerInstructions?: unknown } | undefined)
      ?.developerInstructions
    expect(typeof instructions).toBe("string")
    for (const file of [
      ".env", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "daemon.token",
      "credentials.json", ".ssh", ".npmrc", ".netrc", ".pypirc", "in any letter case",
    ]) {
      expect(instructions).toContain(file)
    }
    expect(instructions).toContain("Operation not permitted")
    expect(instructions).toMatch(/say so in your reply/)
    transport.receive({ id: 3, result: { thread: { id: "thread-notice" } } })
    await expect(starting).resolves.toBe("thread-notice")
    await adapter.close()
  })

  it("initializes, starts a turn, streams events, and resolves approval", async () => {
    const transport = new FakeTransport()
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)

    const connecting = adapter.connect()
    expect(transport.sent[0]).toMatchObject({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "domovoi", title: "Domovoi", version: "9.8.7-test" },
        capabilities: { experimentalApi: true },
      },
    })
    transport.receive({ id: 1, result: {} })
    await connecting
    expect(transport.sent[1]).toEqual({ method: "initialized", params: {} })

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("build", false) })
    expect(transport.sent[2]).toEqual({ id: 2, method: "config/read", params: { cwd: "/worktree" } })
    transport.receive({ id: 2, result: { config: {}, origins: {} } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[3]).toMatchObject({
      id: 3,
      method: "thread/start",
      params: {
        cwd: "/worktree",
        model: "gpt-5.6-sol",
        sandbox: "workspace-write",
        serviceName: "domovoi",
      },
    })
    transport.receive({ id: 3, result: { thread: { id: "thread-1" } } })
    await expect(starting).resolves.toBe("thread-1")

    const stopping = adapter.stopThread("thread-old")
    expect(transport.sent[4]).toMatchObject({
      id: 4,
      method: "thread/archive",
      params: { threadId: "thread-old" },
    })
    transport.receive({ id: 4, result: {} })
    await expect(stopping).resolves.toBeUndefined()

    const turning = adapter.startTurn({
      threadId: "thread-1",
      cwd: "/worktree",
      prompt: "Run the tests",
      runtime: runtime("build", false),
    })
    await vi.waitFor(() => expect(transport.sent[5]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[5]).toMatchObject({
      id: 5,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "Run the tests" }],
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.6-sol",
            reasoning_effort: "medium",
            developer_instructions: null,
          },
        },
        approvalPolicy: "on-request",
        permissions: "domovoi-build",
      },
    })
    expect(transport.sent[5]?.params).not.toHaveProperty("sandboxPolicy")
    transport.receive({ id: 5, result: { turn: { id: "turn-1" } } })
    await expect(turning).resolves.toBe("turn-1")

    const steering = adapter.steerTurn("thread-1", "turn-1", "Focus on the failing test")
    expect(transport.sent[6]).toMatchObject({
      id: 6,
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Focus on the failing test" }],
      },
    })
    transport.receive({ id: 6, result: { turnId: "turn-1" } })
    await expect(steering).resolves.toBeUndefined()

    const interrupting = adapter.interruptTurn("thread-1", "turn-1")
    expect(transport.sent[7]).toMatchObject({
      id: 7,
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    })
    transport.receive({ id: 7, result: {} })
    await expect(interrupting).resolves.toBeUndefined()

    transport.receive({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", delta: "Tests are running." },
    })
    transport.receive({
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        command: "pnpm test",
        cwd: "/worktree",
        reason: "Run project tests",
      },
    })
    expect(event).toHaveBeenCalledWith(expect.objectContaining({
      type: "text-delta",
      delta: "Tests are running.",
    }))
    expect(event).toHaveBeenCalledWith(expect.objectContaining({
      type: "approval-requested",
      requestId: 41,
      command: "pnpm test",
    }))

    adapter.resolveApproval(41, "always-project")
    expect(transport.sent.at(-1)).toEqual({ id: 41, result: { decision: "accept" } })
    // An answer to a request Codex is no longer waiting on, or never asked,
    // is not sent, and says so (ruling Q285).
    const sent = transport.sent.length
    expect(() => adapter.resolveApproval(41, "allow-once")).toThrow(ApprovalRequestNotPendingError)
    expect(() => adapter.resolveApproval(99, "deny")).toThrow(ApprovalRequestNotPendingError)
    expect(transport.sent).toHaveLength(sent)
    await adapter.close()
  })

  it.each([undefined, "", "/reported-command-dir"])("marks only a per-request command cwd: %s", async (cwd) => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting
    try {
      transport.receive({
        id: 42,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-cwd", turnId: "turn-cwd", command: "pwd", ...(cwd === undefined ? {} : { cwd }) },
      })
      const approval = events.find((event) => event.type === "approval-requested")!
      expect(approval).toMatchObject({ type: "approval-requested", requestId: 42, command: "pwd" })
      if (cwd) expect(approval).toMatchObject({ cwd, cwdSource: "request" })
      else expect(approval).not.toHaveProperty("cwdSource")
      // Keep the existing cwd transport behavior, including an empty string.
      if (cwd === undefined) expect(approval).not.toHaveProperty("cwd")
      else expect(approval).toHaveProperty("cwd", cwd)
    } finally {
      await adapter.close()
    }
  })

  // Walk finding F15. The person's ~/.codex/config.toml set approvals_reviewer
  // to auto_review, and Codex 0.162.1 sent the request to run outside the
  // sandbox to its own reviewer: Domovoi never saw it. Domovoi now names the
  // person as the reviewer on every thread and turn, and refuses a thread
  // Codex says still goes to another reviewer.
  it("routes every approval to the person, never to Codex's own reviewer", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("ask", false) })
    transport.receive({ id: 2, result: { config: {}, origins: {} } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[3]).toMatchObject({
      method: "thread/start",
      params: { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "read-only" },
    })
    transport.receive({ id: 3, result: { thread: { id: "thread-1" }, approvalsReviewer: "user" } })
    await expect(starting).resolves.toBe("thread-1")

    const resuming = adapter.resumeThread({ threadId: "thread-1", cwd: "/worktree", runtime: runtime("ask", false) })
    await vi.waitFor(() => expect(transport.sent[4]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[4]).toMatchObject({ method: "thread/resume", params: { threadId: "thread-1", approvalsReviewer: "user" } })
    transport.receive({ id: 4, result: { thread: { id: "thread-1" }, approvalsReviewer: "user" } })
    await expect(resuming).resolves.toBeUndefined()

    const turning = adapter.startTurn({ threadId: "thread-1", cwd: "/worktree", prompt: "run touch walk-gate.txt", runtime: runtime("ask", false) })
    await vi.waitFor(() => expect(transport.sent[5]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[5]).toMatchObject({
      method: "turn/start",
      params: { approvalPolicy: "on-request", approvalsReviewer: "user", permissions: "domovoi-read" },
    })
    transport.receive({ id: 5, result: { turn: { id: "turn-1" } } })
    await expect(turning).resolves.toBe("turn-1")
    await adapter.close()
  })

  it.each(["auto_review", "guardian_subagent"])("refuses a thread whose approvals Codex says go to %s", async (reviewer) => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("ask", false) })
    transport.receive({ id: 2, result: { config: {}, origins: {} } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined(), { timeout: 5_000 })
    transport.receive({ id: 3, result: { thread: { id: "thread-1" }, approvalsReviewer: reviewer } })
    await expect(starting).rejects.toThrow(`Codex would send this thread's approvals to its own reviewer (${reviewer})`)

    const resuming = adapter.resumeThread({ threadId: "thread-2", cwd: "/worktree", runtime: runtime("ask", false) })
    await vi.waitFor(() => expect(transport.sent[4]).toBeDefined(), { timeout: 5_000 })
    transport.receive({ id: 4, result: { thread: { id: "thread-2" }, approvalsReviewer: reviewer } })
    await expect(resuming).rejects.toThrow(`Codex would send this thread's approvals to its own reviewer (${reviewer})`)
    await adapter.close()
  })

  // The request codex-cli 0.162.1 sent for "run touch walk-gate.txt" in Ask,
  // captured from its app-server on 2026-10-15 with the scratch path replaced.
  const escalation01621 = {
    method: "item/commandExecution/requestApproval",
    params: {
      kind: "command",
      threadId: "01a141dd-830e-7d92-8a20-d38ba3713a3b",
      turnId: "01a141dd-8323-7642-95c8-33f2d5359cd9",
      itemId: "exec-fcdecd52-c755-45af-aa18-fd4bb55955c4",
      startedAtMs: 1792106403744,
      environmentId: "local",
      reason: "Allow creating walk-gate.txt in the current directory? The active sandbox permits only reads.",
      command: "/bin/zsh -lc 'touch walk-gate.txt'",
      cwd: "/worktree",
      commandActions: [{ type: "unknown", command: "touch walk-gate.txt" }],
      proposedExecpolicyAmendment: ["touch", "walk-gate.txt"],
      availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["touch", "walk-gate.txt"] } }, "cancel"],
    },
  } as const

  it("raises a gate for the Codex 0.162.1 request to run outside the sandbox and answers it once", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    // Codex numbers its own requests from 0.
    transport.receive({ id: 0, ...escalation01621 })
    expect(events).toEqual([{
      type: "approval-requested",
      requestId: 0,
      threadId: escalation01621.params.threadId,
      turnId: escalation01621.params.turnId,
      itemId: escalation01621.params.itemId,
      command: "/bin/zsh -lc 'touch walk-gate.txt'",
      cwd: "/worktree",
      cwdSource: "request",
      reason: escalation01621.params.reason,
    }])
    // Allow once runs it once: never the execpolicy amendment Codex offers.
    adapter.resolveApproval(0, "allow-once")
    expect(transport.sent.at(-1)).toEqual({ id: 0, result: { decision: "accept" } })

    transport.receive({ id: 1, ...escalation01621 })
    adapter.resolveApproval(1, "deny")
    // Codex 0.162.1 accepts decline though it lists only accept and cancel,
    // and tells the model the request was rejected (measured 2026-10-15).
    expect(transport.sent.at(-1)).toEqual({ id: 1, result: { decision: "decline" } })
    await adapter.close()
  })

  // A backstop for a Codex that ignores the reviewer Domovoi names: its own
  // reviewer took about two seconds to approve in the walk, so Domovoi stops
  // the app-server the moment a review starts.
  it.each([
    "item/autoApprovalReview/started",
    "item/autoApprovalReview/completed",
  ])("stops Codex when %s reports its own reviewer deciding an approval", async (method) => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    transport.receive({
      method,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        reviewId: "review-1",
        targetItemId: "exec-1",
        review: { status: "inProgress" },
        action: { type: "command", command: "/bin/zsh -lc 'touch walk-gate.txt'", cwd: "/worktree" },
      },
    })
    expect(events).toEqual([{
      type: "provider-disconnected",
      reason: "Codex asked its own reviewer to decide an approval instead of asking you through Domovoi, so Domovoi stopped Codex. The reviewer may have answered before Codex stopped: check the session's changes.",
    }])
    expect(transport.closeCount).toBe(1)
    await expect(adapter.listModels()).rejects.toThrow("Codex adapter is not connected")
  })

  // Domovoi shows command approvals and tool server calls as cards. Any other
  // request Codex waits on is refused at once, Codex is told, and the session
  // shows a refusal, so nothing waits on an answer that never comes and
  // nothing is declined unseen.
  it.each([
    ["item/fileChange/requestApproval", { itemId: "patch-1", reason: "Write outside the worktree", grantRoot: "/outside" }, { result: { decision: "decline" } }, "item/fileChange/requestApproval", "Write outside the worktree"],
    ["item/permissions/requestApproval", { itemId: "perm-1", cwd: "/worktree", permissions: { network: { enabled: true } } }, { result: { permissions: {} } }, "item/permissions/requestApproval", "Codex sent item/permissions/requestApproval"],
    ["item/tool/requestUserInput", { itemId: "ask-1", isBlocking: true, questions: [] }, { error: { code: -32601, message: "Domovoi does not handle item/tool/requestUserInput" } }, "item/tool/requestUserInput", "Codex sent item/tool/requestUserInput"],
    ["item/somethingNew/requestApproval", { itemId: "new-1", command: "rm -rf build", reason: "Clean the build" }, { error: { code: -32601, message: "Domovoi does not handle item/somethingNew/requestApproval" } }, "rm -rf build", "Clean the build"],
    // A device-authenticated approval in the 0.162.1 schema: an MCP server's
    // own request, declined and shown (ruling Q156 A).
    ["mcpServer/elicitation/request", { itemId: "verify-1", serverName: "bank", mode: "openai/userVerification", title: "Verify", description: "Confirm the transfer", challenge: "c-1" }, { result: { action: "decline", content: null } }, "bank", "Message sent with the request, not checked by Domovoi: Confirm the transfer"],
  ] as const)("refuses %s visibly and tells Codex", async (method, params, answer, command, operation) => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    transport.receive({ id: 7, method, params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1, ...params } })
    expect(transport.sent.at(-1)).toEqual({ id: 7, ...answer })
    expect(events).toEqual([{
      type: "policy-refused",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: params.itemId,
      command,
      reason: operation,
      refusal: codexRequestRefusal,
    }])
    expect(() => adapter.resolveApproval(7, "allow-once")).toThrow(ApprovalRequestNotPendingError)
    await adapter.close()
  })

  it.each([
    ["execCommandApproval", { conversationId: "thread-1", callId: "call-1", command: ["touch", "walk-gate.txt"], cwd: "/worktree", parsedCmd: [] }, "touch walk-gate.txt"],
    ["applyPatchApproval", { conversationId: "thread-1", callId: "call-1", fileChanges: {}, reason: "Edit the readme" }, "applyPatchApproval"],
  ] as const)("refuses the older %s request visibly and tells Codex", async (method, params, command) => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    transport.receive({ id: 8, method, params })
    // denied is a string in older Codex and an object with a rejection in
    // 0.162.1; abort reads the same in both.
    expect(transport.sent.at(-1)).toEqual({ id: 8, result: { decision: "abort" } })
    expect(events).toEqual([expect.objectContaining({ type: "policy-refused", threadId: "thread-1", itemId: "call-1", command, refusal: codexRequestRefusal })])
    await adapter.close()
  })

  // Domovoi's approval ids are numbers, so a request with a string id never
  // becomes a card: it is refused, shown, and answered under its own id.
  it.each([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
  ] as const)("refuses %s with a string id visibly and answers it under that id", async (method) => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    transport.receive({ id: "approval-85", method, params: { threadId: "thread-1", turnId: "turn-1", itemId: "exec-1", command: "touch walk-gate.txt" } })
    expect(transport.sent.at(-1)).toEqual({ id: "approval-85", result: { decision: "decline" } })
    expect(events).toEqual([expect.objectContaining({ type: "policy-refused", threadId: "thread-1", command: "touch walk-gate.txt", refusal: codexRequestRefusal })])
    expect(events.some((event) => event.type === "approval-requested")).toBe(false)
    await adapter.close()
  })

  it("stops Codex when a request it cannot show names no session", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    transport.receive({ id: 10, method: "item/somethingNew/requestApproval", params: { command: "rm -rf build" } })
    expect(transport.sent.at(-1)).toEqual({ id: 10, error: { code: -32601, message: "Domovoi does not handle item/somethingNew/requestApproval" } })
    expect(events).toEqual([{
      type: "provider-disconnected",
      reason: "Codex sent a request Domovoi cannot show and could not tie to a session (item/somethingNew/requestApproval). Domovoi refused it and stopped Codex.",
    }])
    expect(transport.closeCount).toBe(1)
  })

  it("bounds what a refusal quotes from the request", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    transport.receive({
      id: 11,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "patch-1", reason: "a".repeat(20_000), command: "b".repeat(40_000) },
    })
    const refusal = events.find((event) => event.type === "policy-refused")
    expect(refusal?.type === "policy-refused" && refusal.reason.length).toBeLessThanOrEqual(1_024)
    expect(refusal?.type === "policy-refused" && refusal.command.length).toBeLessThanOrEqual(4_096)
    await adapter.close()
  })

  // Requests that ask nothing of the person, only the client for a service
  // Domovoi does not offer, get an error and no refusal.
  it.each([
    ["attestation/generate", {}],
    ["currentTime/read", { threadId: "thread-1" }],
    ["item/tool/call", { threadId: "thread-1", turnId: "turn-1", callId: "call-1", tool: "lookup", arguments: {} }],
    ["account/chatgptAuthTokens/refresh", { reason: "unauthorized" }],
  ] as const)("answers %s with an error and no refusal", async (method, params) => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    transport.receive({ id: 9, method, params })
    expect(transport.sent.at(-1)).toEqual({ id: 9, error: { code: -32601, message: `Domovoi does not handle ${method}` } })
    expect(events).toEqual([])
    await adapter.close()
  })

  // Codex 0.157 asks before a tool server's tool runs with an MCP elicitation
  // marked codex_approval_kind mcp_tool_call, after the call's mcpToolCall item
  // has started. The card names the server; an answer never asks Codex to
  // remember it (no persist), so Always stays Domovoi's to refuse.
  it("raises an approval for a tool server call Codex asks about", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const events: AgentEvent[] = []
    adapter.onEvent((next) => events.push(next))
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting
    const common = { threadId: "thread-1", turnId: "turn-1" }
    const mcpItem = (method: string, id: string, server: string, turnId: string, args?: unknown) => transport.receive({
      method,
      params: {
        threadId: "thread-1",
        turnId,
        item: { type: "mcpToolCall", id, server, tool: "create_issue", status: method === "item/started" ? "inProgress" : "completed", ...(args === undefined ? {} : { arguments: args }) },
      },
    })
    const marked = { codex_approval_kind: "mcp_tool_call" }
    const ask = (id: number, serverName: string, meta: Record<string, unknown> | undefined, shape: Record<string, unknown> = {}) => transport.receive({
      id,
      method: "mcpServer/elicitation/request",
      params: {
        ...common,
        serverName,
        mode: "form",
        message: `Allow the ${serverName} MCP server to run tool "create_issue"?`,
        requestedSchema: { type: "object", properties: {} },
        ...(meta ? { _meta: meta } : {}),
        ...shape,
      },
    })
    const approvals = () => events.filter((candidate) => candidate.type === "approval-requested")
    const declined = (id: number) => expect(transport.sent.at(-1)).toEqual({ id, result: { action: "decline", content: null } })

    // The card's first line is what Domovoi checked: the running call's tool,
    // its server and its arguments. The request's own message follows,
    // labelled as unchecked.
    mcpItem("item/started", "mcp-1", "github", "turn-1", { title: "Fix login bug" })
    ask(51, "github", { ...marked, persist: ["session", "always"] })
    expect(approvals().at(-1)).toEqual({
      type: "approval-requested",
      requestId: 51,
      ...common,
      itemId: "mcp-1",
      command: "github.create_issue",
      tool: "github.create_issue",
      toolServer: { name: "github" },
      reason: 'Call create_issue on the github tool server. Arguments: {"title":"Fix login bug"}. '
        + 'Message sent with the request, not checked by Domovoi: Allow the github MCP server to run tool "create_issue"?',
    })
    adapter.resolveApproval(51, "always-project")
    expect(transport.sent.at(-1)).toEqual({ id: 51, result: { action: "accept", content: null } })

    // A call whose arguments did not arrive says so.
    mcpItem("item/completed", "mcp-1", "github", "turn-1")
    mcpItem("item/started", "mcp-5", "github", "turn-1")
    ask(57, "github", marked)
    expect(approvals().at(-1)).toMatchObject({
      requestId: 57,
      itemId: "mcp-5",
      reason: "Call create_issue on the github tool server. Arguments are not available. "
        + 'Message sent with the request, not checked by Domovoi: Allow the github MCP server to run tool "create_issue"?',
    })
    adapter.resolveApproval(57, "deny")
    declined(57)

    // A server's own question is not an approval: no card. It is declined
    // (ruling Q156 A) and the session shows the refusal.
    ask(58, "github", undefined)
    expect(approvals()).toHaveLength(2)
    declined(58)
    expect(events.at(-1)).toEqual({
      type: "policy-refused",
      ...common,
      command: "github",
      reason: 'Message sent with the request, not checked by Domovoi: Allow the github MCP server to run tool "create_issue"?',
      refusal: codexRequestRefusal,
    })
    await adapter.close()
  })

  // Security review round 1 of #665: Codex passes an MCP server's own
  // elicitation _meta through to the client, so the marker alone proves
  // nothing. A marked request Domovoi cannot tie to exactly one running call
  // of that server on the same thread and turn, or that is not the empty form
  // Codex sends, is declined at once and gets no card.
  it("declines a marked tool server request it cannot tie to one running call", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const events: AgentEvent[] = []
    adapter.onEvent((next) => events.push(next))
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting
    const started = (id: string, server: string, turnId: string) => transport.receive({
      method: "item/started",
      params: { threadId: "thread-1", turnId, item: { type: "mcpToolCall", id, server, tool: "create_issue", status: "inProgress", arguments: {} } },
    })
    const ask = (id: number, serverName: string, shape: Record<string, unknown> = {}) => transport.receive({
      id,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName,
        mode: "form",
        message: "Allow this?",
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call" },
        ...shape,
      },
    })
    const declined = (id: number) => expect(transport.sent.at(-1)).toEqual({ id, result: { action: "decline", content: null } })

    // No running call at all, for a URL request.
    ask(61, "docs", { mode: "url", url: "https://docs.example.test/consent", elicitationId: "e-1" })
    declined(61)
    // A call from another turn is never borrowed.
    started("mcp-a", "linear", "turn-1")
    ask(62, "linear", { turnId: "turn-2" })
    declined(62)
    // Two running calls of the server: which one is asked about is unknown.
    started("mcp-b", "jira", "turn-1")
    started("mcp-c", "jira", "turn-1")
    ask(63, "jira")
    declined(63)
    // One matching call, but not the empty form Codex sends.
    started("mcp-d", "github", "turn-1")
    ask(64, "github", { requestedSchema: { type: "object", properties: { reason: { type: "string" } } } })
    declined(64)
    ask(65, "github", { mode: "url", url: "https://example.test", elicitationId: "e-2" })
    declined(65)
    expect(events.filter((candidate) => candidate.type === "approval-requested")).toHaveLength(0)
    // Never declined unseen: each decline shows as a refusal in the session.
    expect(events.filter((candidate) => candidate.type === "policy-refused").map((candidate) => candidate.type === "policy-refused" && candidate.command))
      .toEqual(["docs", "linear", "jira", "github", "github"])
    await adapter.close()
  })

  it("starts Plan turns in Codex's native plan collaboration mode", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const turning = adapter.startTurn({
      threadId: "thread-plan",
      cwd: "/worktree",
      prompt: "Plan the work",
      runtime: runtime("plan", false),
    })
    await vi.waitFor(() => expect(transport.sent[2]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[2]).toMatchObject({
      id: 2,
      method: "turn/start",
      params: {
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5.6-sol",
            reasoning_effort: "medium",
            developer_instructions: null,
          },
        },
      },
    })
    transport.receive({ id: 2, result: { turn: { id: "turn-plan" } } })
    await expect(turning).resolves.toBe("turn-plan")
    await adapter.close()
  })

  it("falls back to a plain Plan turn when collaboration mode is unavailable", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const turning = adapter.startTurn({
      threadId: "thread-plan-fallback",
      cwd: "/worktree",
      prompt: "Plan the work",
      runtime: runtime("plan", false),
    })
    await vi.waitFor(() => expect(transport.sent[2]).toBeDefined(), { timeout: 5_000 })
    transport.receive({
      id: 2,
      error: { message: "turn/start.collaborationMode requires experimentalApi capability" },
    })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[3]).toMatchObject({
      id: 3,
      method: "turn/start",
      params: {
        threadId: "thread-plan-fallback",
        input: [{ type: "text", text: "Plan the work" }],
      },
    })
    expect(transport.sent[3]?.params).not.toHaveProperty("collaborationMode")
    expect(transport.sent[3]?.params).toMatchObject({
      additionalContext: { "domovoi-sandbox": { kind: "application", value: codexDeveloperInstructions } },
    })
    transport.receive({ id: 3, result: { turn: { id: "turn-plan-fallback" } } })
    await expect(turning).resolves.toBe("turn-plan-fallback")
    await adapter.close()
  })

  it("keeps the sandbox context when collaboration mode is unavailable, and drops only what Codex rejects", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const turning = adapter.startTurn({ threadId: "thread-old", cwd: "/worktree", prompt: "Go on", runtime: runtime("build", false) })
    await vi.waitFor(() => expect(transport.sent[2]).toBeDefined(), { timeout: 5_000 })
    transport.receive({ id: 2, error: { message: "turn/start.collaborationMode requires experimentalApi capability" } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[3]?.params).not.toHaveProperty("collaborationMode")
    expect(transport.sent[3]?.params).toHaveProperty("additionalContext")
    transport.receive({ id: 3, error: { message: "turn/start.additionalContext requires experimentalApi capability" } })
    await vi.waitFor(() => expect(transport.sent[4]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[4]?.params).not.toHaveProperty("collaborationMode")
    expect(transport.sent[4]?.params).not.toHaveProperty("additionalContext")
    transport.receive({ id: 4, result: { turn: { id: "turn-old" } } })
    await expect(turning).resolves.toBe("turn-old")

    const next = adapter.startTurn({ threadId: "thread-old", cwd: "/worktree", prompt: "Again", runtime: runtime("build", false) })
    await vi.waitFor(() => expect(transport.sent[5]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[5]).toMatchObject({ id: 5, method: "turn/start" })
    expect(transport.sent[5]?.params).not.toHaveProperty("collaborationMode")
    expect(transport.sent[5]?.params).not.toHaveProperty("additionalContext")
    transport.receive({ id: 5, result: { turn: { id: "turn-next" } } })
    await expect(next).resolves.toBe("turn-next")
    await adapter.close()
  })

  it.each([
    ["ask", false],
    ["plan", false],
    ["build", false],
    ["build", true],
  ] as const)("tells every %s Codex turn which worktree files its sandbox refuses, so resumed threads learn it too", async (mode, auto) => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const turning = adapter.startTurn({ threadId: "thread-old", cwd: "/worktree", prompt: "Go on", runtime: runtime(mode, auto) })
    await vi.waitFor(() => expect(transport.sent[2]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[2]).toMatchObject({
      id: 2,
      method: "turn/start",
      params: {
        additionalContext: { "domovoi-sandbox": { kind: "application", value: codexDeveloperInstructions } },
      },
    })
    transport.receive({ id: 2, result: { turn: { id: "turn-old" } } })
    await expect(turning).resolves.toBe("turn-old")
    await adapter.close()
  })

  it("drops the sandbox context and keeps collaboration mode when Codex does not accept additionalContext", async () => {
    const transport = new FakeTransport()
    const adapter = new CodexAppServerAdapter(() => transport)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    const turning = adapter.startTurn({ threadId: "thread-1", cwd: "/worktree", prompt: "Go", runtime: runtime("build", false) })
    await vi.waitFor(() => expect(transport.sent[2]).toBeDefined(), { timeout: 5_000 })
    transport.receive({ id: 2, error: { message: "turn/start.additionalContext requires experimentalApi capability" } })
    await vi.waitFor(() => expect(transport.sent[3]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[3]).toMatchObject({ id: 3, method: "turn/start", params: { collaborationMode: { mode: "default" } } })
    expect(transport.sent[3]?.params).not.toHaveProperty("additionalContext")
    transport.receive({ id: 3, result: { turn: { id: "turn-1" } } })
    await expect(turning).resolves.toBe("turn-1")

    const next = adapter.startTurn({ threadId: "thread-1", cwd: "/worktree", prompt: "Again", runtime: runtime("build", false) })
    await vi.waitFor(() => expect(transport.sent[4]).toBeDefined(), { timeout: 5_000 })
    expect(transport.sent[4]).toMatchObject({ id: 4, method: "turn/start", params: { collaborationMode: { mode: "default" } } })
    expect(transport.sent[4]?.params).not.toHaveProperty("additionalContext")
    transport.receive({ id: 4, result: { turn: { id: "turn-2" } } })
    await expect(next).resolves.toBe("turn-2")
    await adapter.close()
  })

  it("emits full structured plans from Codex plan updates", async () => {
    const transport = new FakeTransport()
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    transport.receive({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "I will verify before changing code.",
        plan: [
          { step: "Inspect the failing test", status: "completed" },
          { step: "Implement the fix", status: "inProgress" },
          { step: "Run verification", status: "pending" },
        ],
      },
    })

    expect(event).toHaveBeenCalledWith({
      type: "plan-updated",
      threadId: "thread-1",
      turnId: "turn-1",
      steps: [
        { text: "Inspect the failing test", status: "completed" },
        { text: "Implement the fix", status: "in-progress" },
        { text: "Run verification", status: "pending" },
      ],
    })
    await adapter.close()
  })

  it("emits current context from Codex token-usage notifications", async () => {
    const transport = new FakeTransport()
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    transport.receive({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 510_000,
            inputTokens: 480_000,
            cachedInputTokens: 300_000,
            outputTokens: 30_000,
            reasoningOutputTokens: 20_000,
          },
          last: {
            totalTokens: 128_000,
            inputTokens: 120_000,
            cachedInputTokens: 90_000,
            outputTokens: 8_000,
            reasoningOutputTokens: 5_000,
          },
          modelContextWindow: 200_000,
        },
      },
    })

    expect(event).toHaveBeenCalledWith({
      type: "usage",
      threadId: "thread-1",
      turnId: "turn-1",
      usage: {
        inputTokens: 120_000,
        cachedInputTokens: 90_000,
        outputTokens: 3_000,
        reasoningTokens: 5_000,
        totalTokens: 128_000,
        contextTokens: 128_000,
        contextWindowTokens: 200_000,
        costSource: "unavailable",
      },
    })
    await adapter.close()
  })

  it("counts every request a Codex turn made, not only its last one", async () => {
    const transport = new FakeTransport()
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting
    const breakdown = (input: number, cached: number, output: number, reasoning: number) => ({
      totalTokens: input + output, inputTokens: input, cachedInputTokens: cached,
      outputTokens: output, reasoningOutputTokens: reasoning,
    })
    const update = (turnId: string, total: ReturnType<typeof breakdown>, last: ReturnType<typeof breakdown>) => {
      transport.receive({
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-1", turnId, tokenUsage: { total, last, modelContextWindow: 200_000 } },
      })
    }
    const usageFor = (turnId: string) => event.mock.calls
      .map(([value]) => value as { type: string; turnId?: string; usage?: unknown })
      .filter((value) => value.type === "usage" && value.turnId === turnId)
      .at(-1)?.usage

    // An earlier turn on this thread already spent 50,000 input tokens.
    update("turn-1", breakdown(50_000, 0, 1_000, 0), breakdown(50_000, 0, 1_000, 0))
    // turn-2 makes two requests. Codex reports each one as `last` and adds it to `total`.
    update("turn-2", breakdown(110_000, 40_000, 1_500, 100), breakdown(60_000, 40_000, 500, 100))
    update("turn-2", breakdown(180_000, 95_000, 1_700, 100), breakdown(70_000, 55_000, 200, 0))
    // A repeated notification with the same counters adds nothing.
    update("turn-2", breakdown(180_000, 95_000, 1_700, 100), breakdown(70_000, 55_000, 200, 0))

    expect(usageFor("turn-2")).toEqual({
      inputTokens: 130_000,
      cachedInputTokens: 95_000,
      outputTokens: 600,
      reasoningTokens: 100,
      totalTokens: 130_700,
      // Context stays the last request's own size.
      contextTokens: 70_200,
      contextWindowTokens: 200_000,
      costSource: "unavailable",
    })

    // The next turn starts from the total turn-2 ended on.
    update("turn-3", breakdown(250_200, 95_000, 1_800, 100), breakdown(70_200, 0, 100, 0))
    expect(usageFor("turn-3")).toMatchObject({ inputTokens: 70_200, outputTokens: 100, totalTokens: 70_300 })
    await adapter.close()
  })

  it("carries the provider item id on an agent message delta", async () => {
    const transport = new FakeTransport()
    const event = vi.fn()
    const adapter = new CodexAppServerAdapter(() => transport)
    adapter.onEvent(event)
    const connecting = adapter.connect()
    transport.receive({ id: 1, result: {} })
    await connecting

    transport.receive({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "first" },
    })
    transport.receive({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-2", delta: "second" },
    })

    expect(event).toHaveBeenNthCalledWith(1, {
      type: "text-delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: "first",
    })
    expect(event).toHaveBeenNthCalledWith(2, {
      type: "text-delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-2",
      delta: "second",
    })

    await adapter.close()
  })
})
