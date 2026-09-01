const supportedManagers = ["npm", "pnpm", "bun"]

const plans = {
  npm: (archive) => ({
    install: { command: "npm", args: ["install", "--no-audit", "--no-fund", archive] },
    run: { command: "node", args: ["smoke.mjs"] },
  }),
  pnpm: (archive) => ({
    install: { command: "pnpm", args: ["add", "--ignore-workspace", archive] },
    run: { command: "node", args: ["smoke.mjs"] },
  }),
  bun: (archive) => ({
    install: { command: "bun", args: ["add", archive] },
    run: { command: "bun", args: ["run", "smoke.mjs"] },
  }),
}

export function installPlan(manager, archive) {
  const plan = plans[manager]
  if (!plan) throw new Error(`no install plan for ${manager}`)
  return plan(archive)
}

export function packageManagers({ present, ci }) {
  const run = supportedManagers.filter((manager) => present.includes(manager))
  const skipped = supportedManagers.filter((manager) => !present.includes(manager))
  const failures = ci
    ? skipped.map(
      (manager) => `${manager} is not installed, so the published artifact was not verified against it`,
    )
    : []
  return { run, skipped, failures }
}

export { supportedManagers }
