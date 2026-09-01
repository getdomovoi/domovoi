import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

import { checkWorkflowPins, evaluateWorkflowPins } from "./workflow-pins.mjs"

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-pins-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, dirname(path)), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  return root
}

test("accepts actions pinned to a full commit SHA", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/ci.yml",
    content: [
      "    steps:",
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
    ].join("\n"),
  }]), [])
})

test("accepts an uppercase commit SHA, which GitHub resolves the same", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/ci.yml",
    content: "      - uses: actions/checkout@3D3C42E5AAC5BA805825DA76410C181273BA90B1",
  }]), [])
})

test("accepts a quoted reference, which YAML treats the same as unquoted", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/ci.yml",
    content: [
      "      - uses: \"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\"",
      "      - uses: 'pnpm/setup@84cb39b217b10273981911c288cd62326dc7c6d2'",
    ].join("\n"),
  }]), [])
})

test("reports a quoted tag reference without its quotes", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/ci.yml",
    content: "      - uses: \"actions/setup-node@v7\"",
  }]), [
    ".github/workflows/ci.yml:1: actions/setup-node@v7 is not pinned to a commit SHA",
  ])
})

test("accepts a self-repository reference, which resolves to the running commit", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/ci.yml",
    content: "      - uses: $/.github/actions/setup",
  }]), [])
})

test("reads a quoted uses key, which YAML treats as the same key", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/ci.yml",
    content: "      - \"uses\": actions/checkout@v7",
  }]), [
    ".github/workflows/ci.yml:1: actions/checkout@v7 is not pinned to a commit SHA",
  ])
})

test("reports a tag reference with its file and line", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/ci.yml",
    content: [
      "    steps:",
      "      - uses: actions/setup-node@v7",
      "      - uses: pnpm/setup@84cb39b217b10273981911c288cd62326dc7c6d2 # v2",
    ].join("\n"),
  }]), [
    ".github/workflows/ci.yml:2: actions/setup-node@v7 is not pinned to a commit SHA",
  ])
})

test("reports an abbreviated SHA, which is not immutable", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/release.yml",
    content: "      - uses: actions/checkout@3d3c42e",
  }]), [
    ".github/workflows/release.yml:1: actions/checkout@3d3c42e is not pinned to a commit SHA",
  ])
})

test("reports an action used with no reference at all", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/ci.yml",
    content: "      - uses: actions/checkout",
  }]), [
    ".github/workflows/ci.yml:1: actions/checkout is not pinned to a commit SHA",
  ])
})

test("allows actions and reusable workflows kept inside this repository", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/ci.yml",
    content: [
      "      - uses: ./.github/actions/setup",
      "    uses: ./.github/workflows/verify.yml",
    ].join("\n"),
  }]), [])
})

test("allows a Docker image pinned to a full digest", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/ci.yml",
    content: "      - uses: docker://alpine@sha256:beefcafe0123456789abcdef0123456789abcdef0123456789abcdef01234567",
  }]), [])
})

test("reports a Docker image pinned only to a moving tag", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/ci.yml",
    content: "      - uses: docker://alpine:3.19",
  }]), [
    ".github/workflows/ci.yml:1: docker://alpine:3.19 is not pinned to an image digest",
  ])
})

test("reports a Docker image with a truncated digest", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/ci.yml",
    content: "      - uses: docker://alpine@sha256:1234",
  }]), [
    ".github/workflows/ci.yml:1: docker://alpine@sha256:1234 is not pinned to an image digest",
  ])
})

test("reads composite actions kept in this repository", async (t) => {
  const root = await fixture({
    ".github/workflows/ci.yml": "jobs:\n  verify:\n    steps:\n      - uses: ./.github/actions/setup\n",
    ".github/actions/setup/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@v4\n",
  })
  t.after(() => rm(root, { recursive: true, force: true }))

  assert.deepEqual((await checkWorkflowPins(root)).failures, [
    ".github/actions/setup/action.yml:4: actions/checkout@v4 is not pinned to a commit SHA",
  ])
})

test("fails instead of passing when it finds no workflow at all", async (t) => {
  const root = await fixture({ ".github/workflows/notes.txt": "not a workflow\n" })
  t.after(() => rm(root, { recursive: true, force: true }))

  assert.deepEqual((await checkWorkflowPins(root)).failures, [
    ".github: no workflow or action definition was found, so no reference was checked",
  ])
})

test("fails instead of crashing when the workflow directory is missing", async (t) => {
  const root = await fixture({ "README.md": "no workflows here\n" })
  t.after(() => rm(root, { recursive: true, force: true }))

  assert.deepEqual((await checkWorkflowPins(root)).failures, [
    ".github: no workflow or action definition was found, so no reference was checked",
  ])
})
