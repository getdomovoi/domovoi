// Loaded in the child and its loader thread. Observe real operations without
// replacing their results, throwing synthetic failures or touching a user cache.
const fs = require("node:fs")
const { syncBuiltinESMExports } = require("node:module")
const { dirname, resolve } = require("node:path")

const cache = resolve(process.env.DOMOVOI_TEST_TSX_CACHE)
const report = process.env.DOMOVOI_TEST_TSX_REPORT
const readdirSync = fs.readdirSync
const readFileSync = fs.readFileSync

fs.readdirSync = function (path, ...args) {
  if (resolve(String(path)) === cache) fs.appendFileSync(report, "enumerate\n")
  return readdirSync.call(this, path, ...args)
}
fs.readFileSync = function (path, ...args) {
  const result = readFileSync.call(this, path, ...args)
  if (typeof path === "string" && dirname(resolve(path)) === cache) {
    fs.appendFileSync(report, "cache-hit\n")
  }
  return result
}
syncBuiltinESMExports()
