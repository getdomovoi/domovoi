// The daemon package ships this entry in dist so installed runtimes do not
// depend on the repository's scripts directory.
// @ts-expect-error The workspace installer is JavaScript and is bundled here.
import { installBootstrapDaemon as install } from "../../../scripts/bootstrap-install.mjs"

export { install }
