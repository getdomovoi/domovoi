import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import test from "node:test"

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
  assert.ok(github > publish, "bootstrap needs a v<version> release after both packages publish")
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
