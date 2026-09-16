// Prints the text a phone's pairing scanner reads, and draws it as a QR when
// `qrencode` is on the PATH. Until the daemon prints this itself and the
// desktop draws it, this is how a machine shows a pairing code:
//
//   domovoid pair --client phone --label "iPhone"
//   node scripts/pairing-payload.mjs wss://<tailnet name>:47831/rpc <client credential> [label]
//
// The credential goes to stdout only inside the encoded text; nothing here
// stores it. Pipe to nothing you would not paste the credential into.
import { spawnSync } from "node:child_process"

import { encodePairingPayload, pairingPayloadSchema } from "../packages/protocol/dist/index.js"

const [url, token, label] = process.argv.slice(2)
if (!url || !token) {
  process.stderr.write("usage: node scripts/pairing-payload.mjs <wss url> <client credential> [label]\n")
  process.exit(1)
}

const checked = pairingPayloadSchema.safeParse({ v: 1, url, token, ...(label ? { label } : {}) })
if (!checked.success) {
  const issue = checked.error.issues[0]
  const field = issue?.path[0]
  process.stderr.write(field === "url"
    ? "The address must be wss://, or ws:// on loopback only; the daemon refuses plaintext off loopback and so does the phone.\n"
    : field === "token"
      ? "The credential must be the 43-character value domovoid pair --client printed.\n"
      : `${issue?.message ?? "The payload is not valid"}\n`)
  process.exit(1)
}
const text = encodePairingPayload(checked.data)

process.stdout.write(`${text}\n`)
const drawn = spawnSync("qrencode", ["-t", "ansiutf8", text], { stdio: ["ignore", "inherit", "ignore"] })
if (drawn.error) process.stderr.write("qrencode is not installed; paste the line above into the phone instead, or install qrencode to see it as a QR.\n")
