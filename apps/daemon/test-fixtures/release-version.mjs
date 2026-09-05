import { register } from "node:module"

register(new URL("./release-version-loader.mjs", import.meta.url), import.meta.url)
