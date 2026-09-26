import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const require = createRequire(new URL("../apps/daemon/package.json", import.meta.url))
const { parse } = require("yaml")
const workflow = async (name) => parse(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"))

test("pull requests check their own release metadata with a complete base history", async () => {
  const ci = await workflow("ci")
  const steps = ci.jobs.verify.steps
  const guard = steps.find((step) => step.run?.includes("release:metadata"))
  assert.ok(guard, "CI must reject a publishable PR with no release metadata of its own")
  assert.equal(guard.env.RELEASE_BASE_SHA, "${{ github.event.pull_request.base.sha }}")
  assert.match(guard.if, /pull_request/)
  assert.equal(steps.find((step) => step.uses?.startsWith("actions/checkout@")).with["fetch-depth"], 0)
  assert.equal(ci.on.pull_request_target, undefined)
})

test("version automation uses the tested version command", async () => {
  const release = await workflow("release")
  const action = release.jobs.version.steps.find((step) => step.uses?.startsWith("changesets/action/version@"))
  assert.equal(action.with.script, "pnpm release:version")
  assert.deepEqual(release.jobs.version.permissions, { contents: "write", "pull-requests": "write" })
})

test("release packing reuses the verified archives without concurrent repacking", async () => {
  const release = await workflow("release")
  const commands = release.jobs.pack.steps.flatMap((step) => step.run ? [step.run] : [])
  assert.ok(commands.some((command) => command.includes("release:prepare")), "prepare the immutable publish plan")
  assert.equal(commands.some((command) => command.includes("changeset pack")), false,
    "Changesets packs workspaces concurrently, racing the daemon's embedded protocol prepack")
})

test("publishing verifies downloaded bytes and creates the canonical bootstrap release", async () => {
  const release = await workflow("release")
  const steps = release.jobs.publish.steps
  const publish = steps.findIndex((step) => step.uses?.startsWith("changesets/action/publish@"))
  const verify = steps.findIndex((step) => step.run === "pnpm release:verify")
  const preflight = steps.findIndex((step) => step.run === "pnpm release:preflight")
  const github = steps.findIndex((step) => step.run === "pnpm release:github")
  assert.ok(verify >= 0 && verify < publish, "verify the artifact after download, before npm admission")
  assert.ok(preflight > verify && preflight < publish, "known GitHub conflicts must refuse before npm is immutable")
  assert.ok(github > publish, "bootstrap needs a v<version> release after every package publishes")
  assert.equal(release.jobs.publish.environment, "npm")
  assert.equal(release.jobs.publish.permissions["id-token"], "write")
})

test("publishing stays opt-in behind the exact-commit CI verdict", async () => {
  const release = await workflow("release")
  assert.match(release.jobs.gate.if, /vars.RELEASE_PUBLISHING == 'enabled'/)
  assert.match(release.jobs.gate.if, /refs\/heads\/main/)
  const steps = release.jobs.gate.steps
  const verdict = steps.findIndex((step) => step.run === "pnpm release:gate")
  const mode = steps.findIndex((step) => step.id === "mode")
  assert.ok(verdict >= 0 && mode > verdict)
  assert.equal(release.concurrency["cancel-in-progress"], false)
})

test("version PRs can run while all publishing remains disabled", async () => {
  const release = await workflow("release")
  assert.match(release.jobs.gate.if, /vars.RELEASE_PUBLISHING == 'version-only'/)
  assert.match(release.jobs.pack.if, /vars.RELEASE_PUBLISHING == 'enabled'/)
})

test("initial publishing is an explicit manual choice, admitted before credential use", async () => {
  const release = await workflow("release")
  assert.equal(release.on.workflow_dispatch.inputs.first_publish.type, "boolean")
  assert.equal(release.on.workflow_dispatch.inputs.first_publish.default, false)
  const steps = release.jobs.publish.steps
  const admission = steps.findIndex((step) => step.run === "pnpm release:admit")
  const publishing = steps.findIndex((step) => step.uses?.startsWith("changesets/action/publish@"))
  assert.ok(admission >= 0 && admission < publishing)
  assert.match(steps[admission].env.NPM_BOOTSTRAP_TOKEN, /workflow_dispatch.*first_publish.*secrets.NPM_BOOTSTRAP_TOKEN/)
  assert.match(steps[publishing].env.NODE_AUTH_TOKEN, /workflow_dispatch.*first_publish.*secrets.NPM_BOOTSTRAP_TOKEN/)
  assert.equal(steps[publishing].env.npm_config_provenance, "true")
  const setup = steps.findIndex((step) => step.with?.["registry-url"])
  assert.ok(setup > admission && setup < publishing)
  assert.match(steps[setup].if, /workflow_dispatch.*first_publish/)
  assert.equal(steps[setup].with["registry-url"], "https://registry.npmjs.org")
  assert.equal(release.jobs.publish["timeout-minutes"], 25)
})

// The version job runs changeset version over exactly this plan. Assembling it
// here, without git, shows the version it would write.
async function assertAlphaVersioning(root) {
  const changesets = createRequire(createRequire(import.meta.url).resolve("@changesets/cli/package.json"))
  const load = (name) => import(pathToFileURL(changesets.resolve(name)).href)
  const [{ getPackages }, { readConfig }, { readPreState }, { readChangesets }, { assembleReleasePlan }] = await Promise.all([
    load("@manypkg/get-packages"), load("@changesets/config"), load("@changesets/pre"), load("@changesets/read"),
    load("@changesets/assemble-release-plan"),
  ])
  const packages = await getPackages(root)
  const preState = await readPreState(root)
  assert.equal(preState?.mode, "pre", "Changesets prerelease mode is entered")
  assert.equal(preState.tag, "alpha")
  const { config, errors } = await readConfig(root, packages)
  assert.equal(errors, undefined)
  const plan = assembleReleasePlan(await readChangesets(root), packages, config, preState)
  const alpha = /^\d+\.\d+\.\d+-alpha\.\d+$/u
  for (const release of plan.releases) {
    assert.match(release.newVersion, alpha, `${release.name} would version to ${release.newVersion}`)
  }
  // Nothing pending means a version PR has consumed every changeset, so the
  // public manifests must already carry the alpha it wrote.
  if (plan.releases.length > 0) return
  const published = packages.packages.filter(({ packageJson }) => !packageJson.private)
  assert.ok(published.length > 0, "the workspace has public packages")
  for (const { packageJson } of published) {
    assert.match(packageJson.version, alpha, `${packageJson.name} is at ${packageJson.version}`)
  }
}

test("the next version the release tooling writes is an alpha prerelease", { timeout: 30_000 }, async () => {
  await assertAlphaVersioning(fileURLToPath(new URL("../", import.meta.url)))
})

// In pre mode, changeset version moves the changesets it consumed into
// .changeset/pre/, and the release plan skips them, so a merged version PR
// leaves nothing pending. This is that state, built by hand.
async function versionedFixture(t, version) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-alpha-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (file, content) => {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`)
  }
  await put("package.json", { name: "fixture-root", private: true })
  await put("pnpm-workspace.yaml", "packages:\n  - packages/*\n  - apps/*\n")
  await put("packages/protocol/package.json", { name: "@getdomovoi/protocol", version })
  await put("apps/web/package.json", { name: "@getdomovoi/web", version, private: true })
  await put(".changeset/config.json", await readFile(new URL("../.changeset/config.json", import.meta.url), "utf8"))
  await put(".changeset/pre.json", { mode: "pre", tag: "alpha" })
  await put(".changeset/pre/first-alpha.md", "---\n\"@getdomovoi/protocol\": minor\n---\n\nFirst alpha.\n")
  return root
}

test("the alpha check holds on the commit that merges the version PR", { timeout: 30_000 }, async (t) => {
  await assertAlphaVersioning(await versionedFixture(t, "0.1.0-alpha.0"))
})

test("the alpha check refuses a merged version PR that wrote a plain version", { timeout: 30_000 }, async (t) => {
  await assert.rejects(assertAlphaVersioning(await versionedFixture(t, "0.1.0")), /@getdomovoi\/protocol is at 0\.1\.0/u)
})

test("advisory gates cover development dependencies, where Electron sits", async () => {
  const steps = (await workflow("ci")).jobs.audit.steps
  const audit = steps.find((step) => /\bpnpm audit\b/.test(step.run ?? ""))
  assert.ok(audit, "the audit job must run pnpm audit")
  assert.doesNotMatch(audit.run, /\s(?:--prod|--production|-P|--dev|-D)(?=\s|$)/)
  const review = steps.find((step) => step.uses?.startsWith("actions/dependency-review-action@"))
  const scopes = String(review?.with?.["fail-on-scopes"] ?? "").split(",").map((scope) => scope.trim())
  assert.ok(scopes.includes("runtime"), "dependency review must fail on runtime advisories")
  assert.ok(scopes.includes("development"), "dependency review must fail on development advisories")
})
