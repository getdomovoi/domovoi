import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { type Runtime } from "@getdomovoi/protocol"
import { afterAll, describe, expect, it } from "vitest"

import { approvalFacts, resolveApprovalPath } from "./approval-facts.js"
import { codexAppServerArguments, codexSecretLocations } from "./codex.js"
import { credentialStores } from "./credential-stores.js"
import { resolveCommandExecution } from "./execution-resolution.js"
import { permissionDecisionFor } from "./permission-policy.js"

const workspace = join("/", "worktrees", "session-1")

const runtime: Runtime = {
  provider: "claude-code",
  model: "sonnet",
  reasoning: "high",
  permissionMode: "build",
  auto: false,
}

// Written out by hand, not read from the production list: removing a store
// there has to fail here. Each row is the location the Codex sandbox refuses
// and the home-relative path that names it on a card or a command line.
const requiredStores: readonly { location: string; path: string }[] = [
  { location: "~/.ssh", path: ".ssh" },
  { location: "~/.aws", path: ".aws" },
  { location: "~/.domovoi", path: ".domovoi/daemon.token" },
  { location: "~/.config/gh", path: ".config/gh" },
  { location: "~/.kube", path: ".kube" },
  { location: "~/.docker", path: ".docker/config.json" },
  { location: "~/.netrc", path: ".netrc" },
  { location: "~/.gnupg", path: ".gnupg" },
  { location: "~/.azure", path: ".azure" },
  { location: "~/.config/gcloud", path: ".config/gcloud" },
  { location: "~/.git-credentials", path: ".git-credentials" },
  { location: "~/.config/git/credentials", path: ".config/git/credentials" },
  { location: "~/.npmrc", path: ".npmrc" },
  { location: "~/.pypirc", path: ".pypirc" },
  { location: "~/.password-store", path: ".password-store" },
  { location: "~/.terraform.d", path: ".terraform.d" },
  { location: "~/.vault-token", path: ".vault-token" },
  { location: "~/.pgpass", path: ".pgpass" },
  { location: "~/.my.cnf", path: ".my.cnf" },
  { location: "~/.cargo/credentials.toml", path: ".cargo/credentials.toml" },
  { location: "~/.gem/credentials", path: ".gem/credentials" },
  { location: "~/.config/op", path: ".config/op" },
  { location: "~/.local/share/keyrings", path: ".local/share/keyrings" },
  { location: "~/Library/Keychains", path: "Library/Keychains" },
  { location: "~/.codex/auth.json", path: ".codex/auth.json" },
  { location: "~/.claude/.credentials.json", path: ".claude/.credentials.json" },
]

// Secret file names, one per rule: the extension rule with any stem, including
// none, punctuation, symbols and letters outside ASCII; private keys with any
// suffix; the .env family; and the named files.
const secretFiles: readonly string[] = [
  ...["pem", "key", "p12", "pfx"].flatMap((extension) => (
    ["server", "", "a+", "🔑", "clé"].map((stem) => `${stem}.${extension}`)
  )),
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa.pub", "id_ed25519_work",
  ".env", ".envrc", ".env.production", "secrets.env",
  "credentials.json", "daemon.token", "gh/hosts.yml",
]

const home = join("/", "home", "u")

// The same file, written every way a path or a command line can spell it.
function pathVariants(name: string): { label: string; path: string }[] {
  const parts = name.split("/")
  return [
    { label: "as written", path: `${home}/${name}` },
    { label: "doubled separators", path: `${home}//${parts.join("//")}` },
    { label: "dot components", path: `${home}/./${parts.join("/./")}` },
    { label: "a detour through ..", path: `${home}/${[...parts.slice(0, -1), "x", "..", parts.at(-1)!].join("/")}` },
    { label: "backslashes", path: ["C:", "Users", "u", ...parts].join("\\") },
    { label: "upper case", path: `${home}/${name.toUpperCase()}` },
    { label: "NFD", path: `${home}/${name.normalize("NFD")}` },
    { label: "home relative", path: `~/${name}` },
  ]
}

function commandVariants(path: string): string[] {
  return [
    `cat ${path}`,
    `cat '${path}'`,
    `cat "${path}"`,
    `tool --file=${path}`,
    `docker run -v ${path}:/secret app`,
    `echo ok && cat ${path} | wc -c`,
  ]
}

const hardGate = { action: "review", risk: "hard-gate" }
const hiddenOnCard = /^The file \[REDACTED\](?: in the session worktree|, outside the session worktree)\.$/u

const secretNames = [
  ...requiredStores.map(({ path }) => ({ kind: "store", name: path })),
  ...secretFiles.map((name) => ({ kind: "file", name })),
]

describe("credentialStores", () => {
  it("is the list of locations the Codex sandbox refuses", () => {
    expect(codexSecretLocations).toEqual(credentialStores.map(({ location }) => location))
  })

  it.each(requiredStores)("keeps $location in the list the sandbox, the card and the command gate share", ({ location }) => {
    expect(credentialStores.map((store) => store.location)).toContain(location)
    expect(codexSecretLocations).toContain(location)
    expect(codexAppServerArguments().join(" ")).toContain(`${JSON.stringify(location)}="deny"`)
  })
})

describe("one classifier for card paths and command operands", () => {
  describe.each(secretNames)("the $kind $name", ({ name }) => {
    it.each(pathVariants(name))("hides and hard-gates it on the card: $label", ({ path }) => {
      const facts = approvalFacts({ workspace, path, scope: undefined })
      expect({ affects: facts.affects, sensitive: facts.sensitive })
        .toEqual({ affects: expect.stringMatching(hiddenOnCard), sensitive: true })
    })

    it.each(pathVariants(name))("hard-gates a command that names it: $label", ({ path }) => {
      for (const command of commandVariants(path)) {
        expect({ command, decision: permissionDecisionFor({ runtime, command }) })
          .toEqual({ command, decision: hardGate })
      }
    })

    it("hard-gates a script whose resolved body names it", () => {
      const execution = resolveCommandExecution({
        command: "pnpm test",
        packageScripts: { test: `cat ${home}/${name}` },
      })
      expect(execution.state).toBe("resolved")
      expect(permissionDecisionFor({ runtime: { ...runtime, auto: true }, command: "pnpm test", execution }))
        .toEqual(hardGate)
    })
  })
})

describe("links to a secret, one or two hops through ordinary names", () => {
  let root: string | undefined
  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  async function layout(label: string): Promise<{ tree: string; outside: string }> {
    root ??= await realpath(await mkdtemp(join(tmpdir(), "domovoi-credential-links-")))
    const base = join(root, `case-${label}`)
    const tree = join(base, "worktree")
    const outside = join(base, "outside")
    await mkdir(tree, { recursive: true })
    await mkdir(join(outside, "mid"), { recursive: true })
    await writeFile(join(outside, "settings.txt"), "")
    return { tree, outside }
  }

  async function card(tree: string) {
    const path = join(tree, "plain")
    const facts = approvalFacts({ workspace: tree, path, scope: undefined, resolved: await resolveApprovalPath(tree, path) })
    return { affects: facts.affects, sensitive: facts.sensitive }
  }

  const expected = {
    affects: "The file [REDACTED], outside the session worktree, through a link at [REDACTED].",
    sensitive: true,
  }

  it.each(secretNames.map(({ name }, index) => [name, index] as const))(
    "hides and hard-gates %s at the end of one and two hops, and in the middle of a chain",
    async (name, index) => {
      const oneHop = await layout(`${index}-one`)
      const secret = join(oneHop.outside, name)
      await mkdir(dirname(secret), { recursive: true })
      await writeFile(secret, "")
      await symlink(secret, join(oneHop.tree, "plain"))
      expect(await card(oneHop.tree)).toEqual(expected)

      const twoHops = await layout(`${index}-two`)
      const secretAtEnd = join(twoHops.outside, name)
      await mkdir(dirname(secretAtEnd), { recursive: true })
      await writeFile(secretAtEnd, "")
      await symlink(secretAtEnd, join(twoHops.outside, "mid", "relay.txt"))
      await symlink(join(twoHops.outside, "mid", "relay.txt"), join(twoHops.tree, "plain"))
      expect(await card(twoHops.tree)).toEqual(expected)

      const middle = await layout(`${index}-middle`)
      const secretHop = join(middle.outside, name)
      await mkdir(dirname(secretHop), { recursive: true })
      await symlink(join(middle.outside, "settings.txt"), secretHop)
      await symlink(secretHop, join(middle.tree, "plain"))
      expect(await card(middle.tree)).toEqual(expected)
    },
  )

  it("shows a chain of ordinary names that ends at an ordinary file", async () => {
    const { tree, outside } = await layout("ordinary")
    await symlink(join(outside, "settings.txt"), join(outside, "mid", "relay.txt"))
    await symlink(join(outside, "mid", "relay.txt"), join(tree, "plain"))
    expect(await card(tree)).toEqual({
      affects: `The file ${join(outside, "settings.txt")}, outside the session worktree, through a link at plain.`,
      sensitive: false,
    })
  })
})

describe("negative controls", () => {
  it.each([
    { path: "notes.txt", affects: "The file notes.txt in the session worktree." },
    { path: ".docker/Dockerfile", affects: "The file .docker/Dockerfile in the session worktree." },
    { path: "pem", affects: "The file pem in the session worktree." },
    { path: "key.txt", affects: "The file key.txt in the session worktree." },
    {
      path: `${home}/.domovoi/worktrees/x/file.ts`,
      affects: `The file ${home}/.domovoi/worktrees/x/file.ts, outside the session worktree.`,
    },
  ])("shows $path and gives it a normal gate", ({ path, affects }) => {
    expect(approvalFacts({ workspace, path, scope: undefined })).toMatchObject({ affects, sensitive: false })
    for (const command of [`cat ${path}`, `tool --file=${path}`]) {
      expect({ command, decision: permissionDecisionFor({ runtime, command }) })
        .toEqual({ command, decision: { action: "review", risk: "normal" } })
    }
  })
})
