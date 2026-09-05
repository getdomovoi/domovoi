import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { runSkillCommand } from "./skill-command.js"
import { loadTrustedSkillKeys } from "./skill-signing.js"
import { FileSkillCatalog } from "./skills.js"
import { removeScratchDirectories } from "./test-scratch.js"

const scratchDirectories: string[] = []

afterEach(async () => {
  await removeScratchDirectories(scratchDirectories.splice(0))
})

async function scratch(): Promise<{ home: string; run: ReturnType<typeof terminal> }> {
  const home = await mkdtemp(join(tmpdir(), "domovoi-skill-command-"))
  scratchDirectories.push(home)
  return { home, run: terminal(home) }
}

function terminal(home: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  const run = (...args: string[]) => runSkillCommand(["skill", ...args], {
    home,
    cwd: () => join(home, "project"),
    stdout: (text) => { stdout.push(text) },
    stderr: (text) => { stderr.push(text) },
  })
  return Object.assign(run, { stdout, stderr })
}

async function skillDirectory(home: string, description = "Signed instructions."): Promise<string> {
  const directory = join(home, "skills", "signed")
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: signed\ndescription: ${description}\n---\n\n# Instructions\n`,
  )
  return directory
}

function printedKey(output: string[]): { keyId: string; publicKey: string } {
  const text = output.join("")
  return {
    keyId: /key id:\s+(\S+)/u.exec(text)![1]!,
    publicKey: /public key:\s+(\S+)/u.exec(text)![1]!,
  }
}

describe("domovoid skill", () => {
  it("prints usage for --help and for an unknown action", async () => {
    const { run } = await scratch()

    expect(await run("--help")).toBe(0)
    expect(run.stdout.join("")).toMatch(/^Usage: domovoid skill keygen/u)
    expect(await run("frobnicate")).toBe(1)
    expect(run.stderr.join("")).toMatch(/^Usage: domovoid skill keygen/u)
  })

  it("writes the private key only to the named file and prints the public half", async () => {
    const { home, run } = await scratch()
    const keyPath = join(home, "keys", "skill-signing.pem")

    expect(await run("keygen", keyPath)).toBe(0)

    const pem = await readFile(keyPath, "utf8")
    expect(pem).toContain("BEGIN PRIVATE KEY")
    if (process.platform !== "win32") {
      expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
    }
    const { keyId, publicKey } = printedKey(run.stdout)
    expect(keyId).toMatch(/^ed25519:[a-f0-9]{16}$/u)
    expect(publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/u)
    const printed = [...run.stdout, ...run.stderr].join("")
    expect(printed).not.toContain("PRIVATE KEY")
    for (const line of pem.split("\n").filter((candidate) => candidate && !candidate.startsWith("-"))) {
      expect(printed).not.toContain(line)
    }
  })

  it("never overwrites an existing key file", async () => {
    const { home, run } = await scratch()
    const keyPath = join(home, "existing.pem")
    await writeFile(keyPath, "keep me\n")

    expect(await run("keygen", keyPath)).toBe(1)

    expect(run.stderr.join("")).toContain(`already exists: ${keyPath}`)
    expect(await readFile(keyPath, "utf8")).toBe("keep me\n")
  })

  it("signs a skill so a daemon that trusts the key reports it verified", async () => {
    const { home, run } = await scratch()
    const keyPath = join(home, "skill-signing.pem")
    const directory = await skillDirectory(home)
    await run("keygen", keyPath)
    const { keyId, publicKey } = printedKey(run.stdout)
    const trustPath = join(home, ".domovoi", "skill-trusted-keys.json")

    expect(await run("sign", join(directory, "SKILL.md"), "--key", keyPath)).toBe(0)
    expect(await run("trust", publicKey)).toBe(0)

    expect(run.stdout.join("")).toContain(`signed ${join(directory, "SKILL.md")} with ${keyId}`)
    expect(run.stdout.join("")).toContain(`trusted ${keyId} in ${trustPath}`)
    const declaration = JSON.parse(await readFile(join(directory, "SKILL.md.sig"), "utf8"))
    expect(declaration).toMatchObject({
      version: 1,
      algorithm: "ed25519",
      keyId,
      contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    })
    const [discovered] = await new FileSkillCatalog(
      [{ path: join(home, "skills"), scope: "user", source: "domovoi" }],
      undefined,
      { trustPath },
    ).list()
    expect(discovered).toMatchObject({
      signature: { state: "verified", keyId },
      trust: { state: "trusted", reason: "verified-signature", authority: `signature · ${keyId}` },
    })
  })

  it("accepts the skill directory, re-signs after an edit, and names a missing key", async () => {
    const { home, run } = await scratch()
    const keyPath = join(home, "skill-signing.pem")
    const directory = await skillDirectory(home)
    await run("keygen", keyPath)
    const { publicKey } = printedKey(run.stdout)
    await run("trust", publicKey)
    const trustPath = join(home, ".domovoi", "skill-trusted-keys.json")
    const catalog = new FileSkillCatalog(
      [{ path: join(home, "skills"), scope: "user", source: "domovoi" }],
      undefined,
      { trustPath },
    )

    expect(await run("sign", directory, "--key", keyPath)).toBe(0)
    expect((await catalog.list())[0]?.trust.state).toBe("trusted")

    await skillDirectory(home, "Changed instructions.")
    expect((await catalog.list())[0]?.trust.state).toBe("blocked")
    expect(await run("sign", directory, "--key", keyPath)).toBe(0)
    expect((await catalog.list())[0]?.trust.state).toBe("trusted")

    const missing = join(home, "missing.pem")
    expect(await run("sign", directory, "--key", missing)).toBe(1)
    expect(run.stderr.join("")).toContain(`Could not read the signing key at ${missing}`)
    expect(await run("sign", join(home, "nowhere"), "--key", keyPath)).toBe(1)
    expect(run.stderr.join("")).toContain(`Could not read the skill at ${join(home, "nowhere", "SKILL.md")}`)
  })

  it.skipIf(process.platform === "win32")("refuses a signing key other users can read", async () => {
    const { home, run } = await scratch()
    const keyPath = join(home, "skill-signing.pem")
    const directory = await skillDirectory(home)
    await run("keygen", keyPath)
    await chmod(keyPath, 0o640)

    expect(await run("sign", directory, "--key", keyPath)).toBe(1)

    expect(run.stderr.join("")).toContain("Signing key must not be readable by other users")
    await expect(stat(join(directory, "SKILL.md.sig"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("adds a key to a named trust file once and refuses a malformed key", async () => {
    const { home, run } = await scratch()
    await run("keygen", join(home, "signing.pem"))
    const { keyId, publicKey } = printedKey(run.stdout)
    const trustPath = join(home, "elsewhere", "trusted.json")

    expect(await run("trust", publicKey, "--trust-file", trustPath)).toBe(0)
    expect(await run("trust", publicKey, "--trust-file", trustPath)).toBe(0)
    expect(await run("trust", "not-a-key", "--trust-file", trustPath)).toBe(1)

    expect(run.stdout.join("")).toContain(`trusted ${keyId} in ${trustPath}`)
    expect(run.stdout.join("")).toContain(`${keyId} is already trusted in ${trustPath}`)
    expect(run.stderr.join("")).toContain("Skill signing public key must be the base64 encoding of 32 Ed25519 key bytes")
    expect([...(await loadTrustedSkillKeys(trustPath)).keys.keys()]).toEqual([keyId])
    await expect(stat(join(home, ".domovoi", "skill-trusted-keys.json")))
      .rejects.toMatchObject({ code: "ENOENT" })
  })

  it("reviews a folder with add and installs only with --yes", async () => {
    const { home, run } = await scratch()
    const source = join(home, "work", "pr-triage")
    await mkdir(join(source, "scripts"), { recursive: true })
    await writeFile(join(source, "SKILL.md"), [
      "---",
      "name: pr-triage",
      "description: Triage pull requests.",
      "domovoi:",
      "  manifest:",
      "    version: 1",
      "    capabilities:",
      "      - filesystem.read",
      "      - process.execute",
      "---",
      "",
      "# Instructions",
      "",
    ].join("\n"))
    await writeFile(join(source, "scripts", "triage.ts"), "export const triage = true\n")
    const userTarget = join(home, ".domovoi", "skills", "pr-triage")

    expect(await run("add", source, "--scope", "user")).toBe(0)

    const review = run.stdout.join("")
    expect(review).toMatch(/^skill:\s+pr-triage$/mu)
    expect(review).toMatch(/^description:\s+Triage pull requests\.$/mu)
    expect(review).toMatch(/^capabilities:\s+filesystem\.read, process\.execute$/mu)
    expect(review).toMatch(/^signature:\s+unsigned$/mu)
    expect(review).toMatch(/^trust:\s+untrusted \(unsigned\)$/mu)
    expect(review).toMatch(/^content digest:\s+sha256:[a-f0-9]{64}$/mu)
    expect(review).toMatch(/^source digest:\s+sha256:[a-f0-9]{64}$/mu)
    expect(review).toMatch(/^files:\s+2 \(\d+ bytes\)$/mu)
    expect(review).toContain(`installs to:    ${userTarget} (available)`)
    expect(review).toContain("Nothing installed. Re-run with --yes to install.")
    await expect(stat(userTarget)).rejects.toMatchObject({ code: "ENOENT" })

    expect(await run("add", source, "--scope", "user", "--yes")).toBe(0)
    expect(run.stdout.join("")).toContain(`installed pr-triage to ${userTarget}`)
    expect(await readFile(join(userTarget, "scripts", "triage.ts"), "utf8")).toBe("export const triage = true\n")
    const [installed] = await new FileSkillCatalog(
      [{ path: join(home, ".domovoi", "skills"), scope: "user", source: "domovoi" }],
    ).list()
    expect(installed).toMatchObject({ name: "pr-triage", scope: "user", source: "domovoi" })
  })

  it("installs to the working project with --scope project and names a refusal", async () => {
    const { home, run } = await scratch()
    const source = join(home, "work", "pr-triage")
    await mkdir(source, { recursive: true })
    await writeFile(join(source, "SKILL.md"), "---\nname: pr-triage\ndescription: Triage.\n---\n")
    await mkdir(join(home, "project"), { recursive: true })
    const projectTarget = join(home, "project", ".domovoi", "skills", "pr-triage")

    expect(await run("add", source, "--scope", "project", "--yes")).toBe(0)
    expect(run.stdout.join("")).toContain(`installed pr-triage to ${projectTarget}`)
    expect(await readFile(join(projectTarget, "SKILL.md"), "utf8")).toContain("name: pr-triage")

    await writeFile(join(source, "SKILL.md"), "---\nname: pr-triage\ndescription: Changed.\n---\n")
    expect(await run("add", source, "--scope", "project", "--yes")).toBe(1)
    expect(run.stderr.join("")).toContain(`refused: A different skill already occupies ${projectTarget}`)
    expect(await readFile(join(projectTarget, "SKILL.md"), "utf8")).toContain("description: Triage.")

    await writeFile(join(source, "SKILL.md.sig"), "{}")
    expect(await run("add", source, "--scope", "user", "--yes")).toBe(1)
    expect(run.stderr.join("")).toContain("refused: Blocked skills cannot be installed")
    expect(await run("add", join(home, "nowhere"), "--scope", "user")).toBe(1)
    expect(run.stderr.join("")).toContain(`Skill source is not a readable directory: ${join(home, "nowhere")}`)
    expect(await run("add", source, "--scope", "system")).toBe(1)
    expect(run.stderr.join("")).toMatch(/Usage: domovoid skill keygen/u)
  })

  it.skipIf(process.platform === "win32")("refuses to add a key to a trust file other users can read", async () => {
    const { home, run } = await scratch()
    await run("keygen", join(home, "signing.pem"))
    const { publicKey } = printedKey(run.stdout)
    const trustPath = join(home, ".domovoi", "skill-trusted-keys.json")
    await run("trust", publicKey)
    await chmod(trustPath, 0o644)

    expect(await run("trust", publicKey)).toBe(1)

    expect(run.stderr.join("")).toContain(`Skill trust file must not be readable by other users: ${trustPath}`)
  })
})
