// The npm packages this repository publishes, each listed after the workspace
// packages it needs at runtime. Changesets plans its publish chunks from the
// same edges; publish-order.mjs refuses a plan that breaks one.
// scripts/publish-order.test.mjs checks both against the workspace manifests.
export const publishDependencies = {
  "@getdomovoi/protocol": [],
  "@getdomovoi/credential-store": [],
  "@getdomovoi/daemon": ["@getdomovoi/protocol"],
  "@getdomovoi/cli": ["@getdomovoi/credential-store", "@getdomovoi/protocol"],
}

export const publishablePackages = Object.keys(publishDependencies)
