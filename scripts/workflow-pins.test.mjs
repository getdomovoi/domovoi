import assert from "node:assert/strict"
import test from "node:test"

import { evaluateWorkflowPins } from "./workflow-pins.mjs"

test("accepts actions pinned to a full commit SHA", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/ci.yml",
    content: [
      "    steps:",
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
    ].join("\n"),
  }]), [])
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

test("allows a Docker image reference, which carries its own digest rules", () => {
  assert.deepEqual(evaluateWorkflowPins([{
    path: ".github/workflows/ci.yml",
    content: "      - uses: docker://alpine@sha256:1234",
  }]), [])
})
