// Optional Metro/hermesc compilation entry. Never import from the phone app.
// Compiling this does not execute it in Hermes or exercise native key storage.
import { relayVectorCases } from "./vector-cases"

for (const test of relayVectorCases) test.run()
console.log(`Relay vectors: ${relayVectorCases.length} cases passed`)
