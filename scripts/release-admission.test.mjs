import assert from "node:assert/strict"
import test from "node:test"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"

const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "getdomovoi/domovoi", GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch", RELEASE_PUBLISHING: "enabled", FIRST_PUBLISH: "true", NPM_BOOTSTRAP_TOKEN: "fixture-only" }
const release = { version: "0.1.0-alpha.0", prerelease: true, npmTag: "alpha",
  packages: ["protocol", "daemon"].map((name) => ({ name: `@getdomovoi/${name}`, version: "0.1.0-alpha.0", integrity: `sha512-${name}` })) }

async function check(t, overrides = {}) {
  const { checkReleaseAdmission } = await import("./release-admission.mjs")
  const deadline = bootstrapDeadline(50, "release admission test deadline")
  t.after(() => deadline.clear())
  return checkReleaseAdmission({ env, release, deadline, readPackage: async () => undefined, ...overrides })
}

test("first alpha admission requires manual main dispatch and the explicit switch", async (t) => {
  assert.deepEqual(await check(t), { mode: "first-publish" })
  for (const change of [
    { GITHUB_ACTIONS: "false" }, { GITHUB_REPOSITORY: "somewhere/else" }, { GITHUB_REF: "refs/heads/other" },
    { GITHUB_EVENT_NAME: "push" }, { RELEASE_PUBLISHING: "version-only" }, { NPM_BOOTSTRAP_TOKEN: "" },
  ]) await assert.rejects(check(t, { env: { ...env, ...change } }), /main|manual|enabled|token/i)
})

test("ordinary publishing never reads or accepts the bootstrap credential", async (t) => {
  const normal = { ...env, GITHUB_EVENT_NAME: "push", FIRST_PUBLISH: "false", NPM_BOOTSTRAP_TOKEN: "" }
  assert.deepEqual(await check(t, { env: normal, readPackage: () => assert.fail("no bootstrap registry lookup") }), { mode: "trusted" })
  await assert.rejects(check(t, { env: { ...normal, NPM_BOOTSTRAP_TOKEN: "fixture-only" } }), /bootstrap.*ordinary/i)
})

test("bootstrap cannot publish a stable release or advance an existing package", async (t) => {
  await assert.rejects(check(t, { release: { ...release, prerelease: false, npmTag: "latest" } }), /first alpha/i)
  await assert.rejects(check(t, { readPackage: async () => ({ versions: { "0.1.0-alpha.1": {} } }) }), /already exists|trusted publishing/i)
})

test("a partial first publish can resume only with identical attested bytes", async (t) => {
  const readPackage = async (pkg) => pkg.name.endsWith("daemon") ? undefined : { name: pkg.name,
    versions: { [pkg.version]: { name: pkg.name, version: pkg.version, dist: { integrity: pkg.integrity,
      attestations: { url: "https://registry.npmjs.org/attestations", provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } } } }
  assert.deepEqual(await check(t, { readPackage }), { mode: "first-publish" })
  await assert.rejects(check(t, { readPackage: async (pkg) => ({ versions: { [pkg.version]: { name: pkg.name, version: pkg.version, dist: { integrity: "different" } } } }) }), /integrity|attested/i)
})

test("unknown registry state and a silent registry never authorize a bootstrap", async (t) => {
  await assert.rejects(check(t, { readPackage: async () => { throw new Error("registry 503") } }), /503/)
  await assert.rejects(check(t, { readPackage: async () => ({}) }), /registry/i)
  await assert.rejects(check(t, { readPackage: async () => new Promise(() => {}) }), /deadline/)
})
