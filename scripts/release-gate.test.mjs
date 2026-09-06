import assert from "node:assert/strict"
import test from "node:test"

import { evaluateWorkflowRuns, readWorkflowRuns, requireWorkflowSuccess } from "./release-gate.mjs"

const green = (name) => ({ name, status: "completed", conclusion: "success" })

const passingRun = {
  id: 11,
  status: "completed",
  conclusion: "success",
  jobs: [green("verify (ubuntu-latest)"), green("verify (macos-latest)"), green("verify (windows-latest)"), green("audit")],
}

test("accepts a completed run whose every job succeeded", () => {
  assert.deepEqual(evaluateWorkflowRuns([passingRun]), { state: "passed", reasons: [] })
})

test("refuses a run that concluded failure", () => {
  const run = { ...passingRun, conclusion: "failure", jobs: [green("audit"), { name: "verify (windows-latest)", status: "completed", conclusion: "failure" }] }
  assert.deepEqual(evaluateWorkflowRuns([run]), {
    state: "failed",
    reasons: ["run 11 concluded failure", "run 11 job verify (windows-latest) concluded failure"],
  })
})

test("refuses a green run whose job was skipped, so the gate never ran", () => {
  const run = { ...passingRun, jobs: [green("verify (ubuntu-latest)"), { name: "audit", status: "completed", conclusion: "skipped" }] }
  assert.deepEqual(evaluateWorkflowRuns([run]), { state: "failed", reasons: ["run 11 job audit concluded skipped"] })
})

test("refuses a run that reported no job at all", () => {
  assert.deepEqual(evaluateWorkflowRuns([{ id: 11, status: "completed", conclusion: "success", jobs: [] }]), {
    state: "failed",
    reasons: ["run 11 reported no job, so no gate was observed"],
  })
})

test("waits while a run is still going", () => {
  assert.deepEqual(evaluateWorkflowRuns([{ id: 12, status: "in_progress", conclusion: null, jobs: [] }]), {
    state: "pending",
    reasons: ["run 12 is still in_progress"],
  })
})

test("waits when one run failed and another is still going", () => {
  const failed = { ...passingRun, conclusion: "failure", jobs: [{ name: "audit", status: "completed", conclusion: "failure" }] }
  const running = { id: 12, status: "queued", conclusion: null, jobs: [] }
  assert.equal(evaluateWorkflowRuns([failed, running]).state, "pending")
})

test("accepts a re-run that succeeded after an earlier failure", () => {
  const failed = { ...passingRun, id: 10, conclusion: "failure", jobs: [{ name: "audit", status: "completed", conclusion: "failure" }] }
  assert.deepEqual(evaluateWorkflowRuns([failed, passingRun]), { state: "passed", reasons: [] })
})

test("reports a commit with no run of the required workflow", () => {
  assert.deepEqual(evaluateWorkflowRuns([]), {
    state: "missing",
    reasons: ["no run of the required workflow exists for this commit"],
  })
  assert.equal(evaluateWorkflowRuns(undefined).state, "missing")
})

function stubGitHub(pages) {
  const requested = []
  const fetchImpl = async (url) => {
    requested.push(url)
    const body = pages[url]
    if (!body) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => body }
  }
  return { fetchImpl, requested }
}

const api = "https://api.github.com"
const runsUrl = (page) =>
  `${api}/repos/getdomovoi/domovoi/actions/workflows/ci.yml/runs?head_sha=abc123&per_page=100&page=${page}`
const jobsUrl = (id, page) => `${api}/repos/getdomovoi/domovoi/actions/runs/${id}/jobs?filter=latest&per_page=100&page=${page}`

test("reads the runs for one commit and the jobs of each, across pages", async () => {
  const { fetchImpl, requested } = stubGitHub({
    [runsUrl(1)]: {
      total_count: 2,
      workflow_runs: [
        { id: 11, head_sha: "abc123", status: "completed", conclusion: "success", html_url: "https://example.invalid/11" },
      ],
    },
    [runsUrl(2)]: {
      total_count: 2,
      workflow_runs: [{ id: 12, head_sha: "def456", status: "completed", conclusion: "failure", html_url: "https://example.invalid/12" }],
    },
    [jobsUrl(11, 1)]: { total_count: 2, jobs: [{ name: "audit", status: "completed", conclusion: "success" }] },
    [jobsUrl(11, 2)]: { total_count: 2, jobs: [{ name: "verify (ubuntu-latest)", status: "completed", conclusion: "success" }] },
  })

  const runs = await readWorkflowRuns({
    repository: "getdomovoi/domovoi",
    workflow: "ci.yml",
    sha: "abc123",
    token: "t",
    apiUrl: api,
    fetchImpl,
  })

  assert.deepEqual(runs, [
    {
      id: 11,
      status: "completed",
      conclusion: "success",
      url: "https://example.invalid/11",
      jobs: [
        { name: "audit", status: "completed", conclusion: "success" },
        { name: "verify (ubuntu-latest)", status: "completed", conclusion: "success" },
      ],
    },
  ])
  assert.equal(requested.filter((url) => url.includes("/jobs")).length, 2)
})

test("sends the token and fails loudly on a rejected request", async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.authorization)
    return { ok: false, status: 401, json: async () => ({}) }
  }
  await assert.rejects(
    readWorkflowRuns({ repository: "getdomovoi/domovoi", workflow: "ci.yml", sha: "abc123", token: "secret", apiUrl: api, fetchImpl }),
    /401/,
  )
  assert.deepEqual(seen, ["Bearer secret"])
})

test("waits for a run that starts late and then passes", async () => {
  const responses = [[], [{ id: 12, status: "in_progress", conclusion: null, jobs: [] }], [passingRun]]
  const slept = []
  const verdict = await requireWorkflowSuccess({
    readRuns: async () => responses.shift(),
    pollIntervalMs: 1000,
    deadlineMs: 60_000,
    now: () => 0,
    sleep: async (ms) => void slept.push(ms),
  })

  assert.deepEqual(verdict, { state: "passed", reasons: [] })
  assert.deepEqual(slept, [1000, 1000])
})

test("stops at the first failed run instead of waiting it out", async () => {
  let reads = 0
  const failed = { ...passingRun, conclusion: "failure", jobs: [{ name: "audit", status: "completed", conclusion: "failure" }] }
  const verdict = await requireWorkflowSuccess({
    readRuns: async () => {
      reads += 1
      return [failed]
    },
    pollIntervalMs: 1000,
    deadlineMs: 60_000,
    now: () => 0,
    sleep: async () => assert.fail("a failed run must not be waited on"),
  })

  assert.equal(verdict.state, "failed")
  assert.equal(reads, 1)
})

test("gives up when the deadline passes with the run still going", async () => {
  let clock = 0
  const verdict = await requireWorkflowSuccess({
    readRuns: async () => [{ id: 12, status: "queued", conclusion: null, jobs: [] }],
    pollIntervalMs: 1000,
    deadlineMs: 2000,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  })

  assert.equal(verdict.state, "pending")
  assert.match(verdict.reasons.at(-1), /2000 ms/)
})

test("gives up when the deadline passes with no run at all", async () => {
  let clock = 0
  const verdict = await requireWorkflowSuccess({
    readRuns: async () => [],
    pollIntervalMs: 1000,
    deadlineMs: 1000,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  })

  assert.equal(verdict.state, "missing")
})
