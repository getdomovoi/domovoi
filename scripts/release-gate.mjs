import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

export const defaultWorkflow = "ci.yml"
export const defaultPollIntervalMs = 30_000
export const defaultDeadlineMs = 2_700_000

function jobVerdict(job) {
  if (job.status !== "completed") return `is still ${job.status ?? "unknown"}`
  if (job.conclusion !== "success") return `concluded ${job.conclusion ?? "without a conclusion"}`
  return undefined
}

function runFailures(run) {
  const failures = []
  if (run.conclusion !== "success") {
    failures.push(`run ${run.id} concluded ${run.conclusion ?? "without a conclusion"}`)
  }
  const jobs = Array.isArray(run.jobs) ? run.jobs : []
  if (jobs.length === 0) failures.push(`run ${run.id} reported no job, so no gate was observed`)
  for (const job of jobs) {
    const verdict = jobVerdict(job)
    if (verdict) failures.push(`run ${run.id} job ${job.name} ${verdict}`)
  }
  return failures
}

export function evaluateWorkflowRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return { state: "missing", reasons: ["no run of the required workflow exists for this commit"] }
  }

  const reasons = []
  let waiting = false
  for (const run of runs) {
    if (run.status !== "completed") {
      waiting = true
      reasons.push(`run ${run.id} is still ${run.status ?? "unknown"}`)
      continue
    }
    const failures = runFailures(run)
    if (failures.length === 0) return { state: "passed", reasons: [] }
    reasons.push(...failures)
  }
  return { state: waiting ? "pending" : "failed", reasons }
}

async function requestJson(url, { token, fetchImpl }) {
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "domovoi-release-gate",
      "x-github-api-version": "2022-11-28",
    },
  })
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`)
  return response.json()
}

async function collect(url, key, options) {
  const items = []
  for (let page = 1; ; page += 1) {
    const body = await requestJson(`${url}&per_page=100&page=${page}`, options)
    const batch = body?.[key]
    if (!Array.isArray(batch) || batch.length === 0) return items
    items.push(...batch)
    const total = Number(body.total_count)
    if (!Number.isFinite(total) || items.length >= total) return items
  }
}

export async function readWorkflowRuns({ repository, workflow, sha, token, apiUrl, fetchImpl = fetch }) {
  const options = { token, fetchImpl }
  const actions = `${apiUrl}/repos/${repository}/actions`
  const runs = await collect(
    `${actions}/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${encodeURIComponent(sha)}`,
    "workflow_runs",
    options,
  )

  const gates = []
  for (const run of runs.filter((run) => run.head_sha === sha)) {
    const jobs = await collect(`${actions}/runs/${run.id}/jobs?filter=latest`, "jobs", options)
    gates.push({
      id: run.id,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
      jobs: jobs.map((job) => ({ name: job.name, status: job.status, conclusion: job.conclusion })),
    })
  }
  return gates
}

export async function requireWorkflowSuccess({
  readRuns,
  pollIntervalMs = defaultPollIntervalMs,
  deadlineMs = defaultDeadlineMs,
  now = () => Date.now(),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  report = () => {},
  ...source
}) {
  const read = readRuns ?? (() => readWorkflowRuns(source))
  const started = now()
  for (;;) {
    const verdict = evaluateWorkflowRuns(await read())
    if (verdict.state === "passed" || verdict.state === "failed") return verdict
    const waited = now() - started
    if (waited >= deadlineMs) {
      return { ...verdict, reasons: [...verdict.reasons, `gave up after waiting ${deadlineMs} ms`] }
    }
    report(verdict)
    await sleep(pollIntervalMs)
  }
}

function readOption(argv, flag) {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2)
  const repository = readOption(argv, "--repository") ?? process.env.GITHUB_REPOSITORY
  const sha = readOption(argv, "--sha") ?? process.env.GITHUB_SHA
  const workflow = readOption(argv, "--workflow") ?? defaultWorkflow
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com"
  const deadlineMs = Number(readOption(argv, "--deadline-ms") ?? defaultDeadlineMs)
  const pollIntervalMs = Number(readOption(argv, "--poll-interval-ms") ?? defaultPollIntervalMs)

  if (!repository || !sha || !token) {
    console.error("usage: node scripts/release-gate.mjs [--repository owner/name] [--sha commit] [--workflow file.yml]")
    console.error("GITHUB_REPOSITORY, GITHUB_SHA, and GH_TOKEN or GITHUB_TOKEN supply the defaults")
    process.exitCode = 2
  } else {
    const verdict = await requireWorkflowSuccess({
      repository,
      workflow,
      sha,
      token,
      apiUrl,
      deadlineMs,
      pollIntervalMs,
      report: ({ reasons }) => console.log(`waiting for ${workflow} on ${sha}: ${reasons.join("; ")}`),
    })
    console.log(JSON.stringify({ repository, workflow, sha, ...verdict }, null, 2))
    if (verdict.state !== "passed") process.exitCode = 1
  }
}
