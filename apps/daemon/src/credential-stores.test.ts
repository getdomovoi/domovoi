import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { type Runtime } from "@getdomovoi/protocol"
import { afterAll, describe, expect, it } from "vitest"

import { approvalDirectory, approvalFacts, resolveApprovalPath } from "./approval-facts.js"
import { codexAppServerArguments, codexSecretLocations } from "./codex.js"
import { canonicalPath, commandOperands, credentialStores, operandsReachCredentialPath } from "./credential-stores.js"
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
  ".env", ".envrc", ".env.local", ".env.production", "secrets.env", "prod.env", "app.envrc",
  "credentials.json", "daemon.token", "gh/hosts.yml",
]

const home = join("/", "home", "u")

// ASCII letters in their fullwidth compatibility forms.
function fullwidth(name: string): string {
  return name.replace(/[A-Za-z]/gu, (letter) => String.fromCodePoint(letter.codePointAt(0)! + 0xfee0))
}

// The same file, written every way a path or a command line can spell it. A
// spelling that leaves this name unchanged is left out.
function pathVariants(name: string): { label: string; path: string }[] {
  const parts = name.split("/")
  const variants = [
    { label: "as written", path: `${home}/${name}` },
    { label: "doubled separators", path: `${home}//${parts.join("//")}` },
    { label: "dot components", path: `${home}/./${parts.join("/./")}` },
    { label: "a detour through ..", path: `${home}/${[...parts.slice(0, -1), "x", "..", parts.at(-1)!].join("/")}` },
    { label: "backslashes", path: ["C:", "Users", "u", ...parts].join("\\") },
    { label: "upper case", path: `${home}/${name.toUpperCase()}` },
    { label: "mixed case", path: `${home}/${[...name].map((character, index) => index % 2 === 0 ? character.toUpperCase() : character).join("")}` },
    { label: "NFD", path: `${home}/${name.normalize("NFD")}` },
    { label: "fullwidth letters", path: `${home}/${fullwidth(name)}` },
    { label: "compatibility ligatures", path: `${home}/${name.replaceAll("ffi", "ﬃ").replaceAll("fi", "ﬁ").replaceAll("fl", "ﬂ").replaceAll("ff", "ﬀ")}` },
    { label: "long s and the Kelvin sign", path: `${home}/${name.replaceAll("s", "ſ").replaceAll("k", "K")}` },
    { label: "sharp s, which only case folding reads as ss", path: `${home}/${name.replaceAll("ss", "ß")}` },
    { label: "a zero width joiner", path: `${home}/${name.replace(/(?<=\p{L})(?=\p{L})/u, "‍")}` },
    { label: "home relative", path: `~/${name}` },
  ]
  return variants.filter((variant, index) => index === 0 || variant.path !== variants[0]!.path)
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

// A store that marks itself on a card by a narrower name is still a store as a
// whole: its root, with or without a trailing slash, and a pattern that
// reaches every file in it.
const storeRoots: readonly string[] = [".docker", ".docker/", ".docker/*", ".domovoi", ".domovoi/", ".domovoi/*"]

describe("a whole store known on the card by a narrower name", () => {
  describe.each(storeRoots)("the store root %s", (name) => {
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
  })

  it.each([
    "tar czf x.tgz ~/.docker",
    "tar czf x.tgz ~/.docker/",
    "cp -r ~/.domovoi /tmp/x",
    "cp -r ~/.domovoi/ /tmp/x",
    "cp -r ~/.docker/. /tmp/x",
    "zip -r out.zip ~/.docker",
    "tar -C ~ -czf x.tgz .domovoi",
    `rsync -a ${home}/.domovoi/ /backup/`,
    "cd ~ && tar czf x.tgz .docker",
  ])("hard-gates an archive or copy of the whole store: %s", (command) => {
    expect(permissionDecisionFor({ runtime, command })).toEqual(hardGate)
  })
})

// A shell joins a word across a backslash and a newline, and decodes the
// escapes in an ANSI-C quote before the command runs.
describe("words the shell assembles before running the command", () => {
  it.each([
    "cat .e\\\nnv",
    "cat \".e\\\nnv\"",
    "cat $'\\x2eenv'",
    "cat $'\\056env'",
    "cat $'\\u002eenv'",
    "cat $'.env'",
    "cat $'.en'v",
    "cat $\".env\"",
    `cat ${home}/.a\\\nws/credentials`,
    `cat ${home}/$'\\x2e'aws/credentials`,
    `cat $'${home}/\\056ssh/id'`,
    `cat $'${home}/.ssh\\x2fid'`,
    "tar czf x.tgz ~/.dock\\\ner",
    `cp -r $'${home}/\\x2edomovoi' /tmp/x`,
  ])("hard-gates %j", (command) => {
    expect(permissionDecisionFor({ runtime, command })).toEqual(hardGate)
  })

  it.each([
    "cat '.e\\\nnv'",
    "cat $'notes\\x2etxt'",
  ])("gives %j a normal gate", (command) => {
    expect(permissionDecisionFor({ runtime, command })).toEqual({ action: "review", risk: "normal" })
  })
})

describe("the real path of a name on disk", () => {
  let root: string | undefined
  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  // A store and an ordinary directory, each behind a link with an ordinary
  // name, so only the real path names the store.
  async function layout(): Promise<string> {
    if (root !== undefined) return root
    root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-credential-real-")))
    await mkdir(join(root, ".aws"))
    await writeFile(join(root, ".aws", "credentials"), "")
    await mkdir(join(root, ".docker"))
    await writeFile(join(root, ".docker", "Dockerfile"), "")
    await mkdir(join(root, "notes"))
    await writeFile(join(root, "notes", "a.txt"), "")
    await symlink(join(root, ".aws"), join(root, "plain"))
    await symlink(join(root, ".docker"), join(root, "box"))
    await symlink(join(root, "notes"), join(root, "ordinary"))
    return root
  }

  it.each([
    { label: "a file through a link to a store", path: "plain/credentials" },
    { label: "a file not written yet, through a link to a store", path: "plain/new-file" },
    { label: "a link to a whole store", path: "box" },
  ])("hides and hard-gates $label", async ({ path }) => {
    const base = await layout()
    const workspace = join(base, "worktree")
    const absolute = join(base, path)
    // Only the real path is given, not the links followed on the way.
    const resolved = { target: absolute, workspace, hops: [], canonical: await canonicalPath(absolute) }
    const facts = approvalFacts({ workspace, path: absolute, scope: undefined, resolved })
    expect({ affects: facts.affects, sensitive: facts.sensitive })
      .toEqual({ affects: "The file [REDACTED], outside the session worktree.", sensitive: true })
    expect(await operandsReachCredentialPath(commandOperands(`tar czf x.tgz ${absolute}`), undefined)).toBe(true)
    expect(await operandsReachCredentialPath(commandOperands(`tar czf x.tgz ${path}`), base)).toBe(true)
    expect(approvalDirectory({ directory: absolute, workspace, canonical: await canonicalPath(absolute) }))
      .toEqual({ text: "[REDACTED], outside the session worktree", redacted: false, sensitive: true })
  })

  it("shows an ordinary file behind a link, and a store's ordinary child", async () => {
    const base = await layout()
    const workspace = join(base, "worktree")
    for (const path of ["ordinary/a.txt", "box/Dockerfile"]) {
      const absolute = join(base, path)
      const resolved = { target: absolute, workspace, hops: [], canonical: await canonicalPath(absolute) }
      expect(approvalFacts({ workspace, path: absolute, scope: undefined, resolved }).sensitive).toBe(false)
      expect(await operandsReachCredentialPath(commandOperands(`cat ${path}`), base)).toBe(false)
    }
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
    { path: "src/process.env.HOME.ts", affects: "The file src/process.env.HOME.ts in the session worktree." },
    {
      path: `${home}/.domovoi/worktrees/x/file.ts`,
      affects: `The file ${home}/.domovoi/worktrees/x/file.ts, outside the session worktree.`,
    },
    {
      path: `${home}/.domovoi/worktrees/x`,
      affects: `The file ${home}/.domovoi/worktrees/x, outside the session worktree.`,
    },
    { path: ".docker/compose.yml", affects: "The file .docker/compose.yml in the session worktree." },
    { path: "ﬁle.txt", affects: "The file ﬁle.txt in the session worktree." },
  ])("shows $path and gives it a normal gate", ({ path, affects }) => {
    expect(approvalFacts({ workspace, path, scope: undefined })).toMatchObject({ affects, sensitive: false })
    for (const command of [`cat ${path}`, `tool --file=${path}`]) {
      expect({ command, decision: permissionDecisionFor({ runtime, command }) })
        .toEqual({ command, decision: { action: "review", risk: "normal" } })
    }
  })

  it("gives a command that reads an environment variable in code a normal gate", () => {
    const command = `node -e "console.log(process.env.HOME)"`
    expect(permissionDecisionFor({ runtime, command })).toEqual({ action: "review", risk: "normal" })
  })
})
