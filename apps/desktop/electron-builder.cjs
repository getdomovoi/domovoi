// One policy for local package commands and the protected signing build.
// The YAML remains the source for layout, targets, native modules and entitlements.
const { signingConfiguration } = require("./scripts/signing-config.cjs")

module.exports = {
  extends: "./electron-builder.yml",
  ...signingConfiguration(process.env, process.platform),
}
