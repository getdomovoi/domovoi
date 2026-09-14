import { z } from "zod"

import { machineIdSchema } from "./identifiers.js"
import { maximumRelayFrameBytes, relayBytes32Schema } from "./relay-admission.js"
import { relayRecoveryResultSchema } from "./relay-recovery.js"

// Outer carrier records are separate from the frozen Noise codec and its
// encrypted nine-byte application header. Incompatible carrier changes need
// another carrierVersion; they do not silently revise the frozen codec.
export const relayCarrierVersion = 1
export const maximumRelayCarrierControlBytes = 4_096
export const relayMultiplexHeaderBytes = 4
export const maximumRelayMultiplexedFrameBytes = relayMultiplexHeaderBytes + maximumRelayFrameBytes

const version = z.literal(relayCarrierVersion)
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const channelId = z.number().int().min(1).max(0xffff_ffff)

const registrationSchema = z.object({
  kind: z.literal("register"),
  carrierVersion: version,
  routeId: relayBytes32Schema,
  machineId: machineIdSchema,
  generation,
  // Issued independently of every daemon root token and paired bearer. The
  // relay authenticates this credential; endpoint credentials stay encrypted.
  registrationCredential: relayBytes32Schema,
  recovery: relayRecoveryResultSchema,
}).strict().refine((value) => value.recovery.identity.machineId === value.machineId,
  "Relay registration and recovery must name the same machine")

const connectSchema = z.object({
  kind: z.literal("connect"), carrierVersion: version, routeId: relayBytes32Schema,
}).strict()

// Recovery deliberately precedes admission and accepts no bearer. The cold
// identity signature checked against a saved pin establishes trust, not the
// route, this response, or a public identity fetched from the relay.
const recoveryRequestSchema = z.object({
  kind: z.literal("recover"), carrierVersion: version, routeId: relayBytes32Schema, machineId: machineIdSchema,
}).strict()

export const relayCarrierGreetingSchema = z.discriminatedUnion("kind", [registrationSchema, connectSchema, recoveryRequestSchema])

export const relayCarrierControlSchema = z.discriminatedUnion("kind", [
  registrationSchema,
  connectSchema,
  recoveryRequestSchema,
  z.object({ kind: z.literal("registered"), carrierVersion: version, generation }).strict(),
  z.object({ kind: z.literal("connected"), carrierVersion: version }).strict(),
  z.object({ kind: z.literal("recovery"), recovery: relayRecoveryResultSchema }).strict(),
  z.object({ kind: z.literal("open"), channelId }).strict(),
  z.object({ kind: z.literal("close"), channelId }).strict(),
])

export type RelayCarrierGreeting = z.infer<typeof relayCarrierGreetingSchema>
export type RelayCarrierControl = z.infer<typeof relayCarrierControlSchema>
export type RelayMultiplexedFrame = { channelId: number; frame: Uint8Array }

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

function control(value: unknown): RelayCarrierControl {
  const result = relayCarrierControlSchema.safeParse(value)
  if (!result.success) throw new Error("Invalid relay carrier control record")
  return result.data
}

export function encodeRelayCarrierControl(value: unknown): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(control(value)))
  if (bytes.byteLength > maximumRelayCarrierControlBytes) throw new Error("Relay carrier control exceeds its byte limit")
  return bytes
}

export function parseRelayCarrierControl(bytes: Uint8Array): RelayCarrierControl {
  // Adapters must also cap network messages before materializing these bytes.
  // This bound limits UTF-8 decoding and JSON parsing, not socket allocation.
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maximumRelayCarrierControlBytes) {
    throw new Error("Invalid relay carrier control record")
  }
  let value: unknown
  try { value = JSON.parse(decoder.decode(bytes)) }
  catch { throw new Error("Invalid relay carrier control record") }
  return control(value)
}

export function encodeRelayMultiplexedFrame(id: number, frame: Uint8Array): Uint8Array {
  if (!channelId.safeParse(id).success || !(frame instanceof Uint8Array) || frame.byteLength === 0 || frame.byteLength > maximumRelayFrameBytes) {
    throw new Error("Invalid relay multiplexed frame")
  }
  const result = new Uint8Array(relayMultiplexHeaderBytes + frame.byteLength)
  new DataView(result.buffer).setUint32(0, id, true)
  result.set(frame, relayMultiplexHeaderBytes)
  return result
}

export function decodeRelayMultiplexedFrame(bytes: Uint8Array): RelayMultiplexedFrame {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength <= relayMultiplexHeaderBytes || bytes.byteLength > maximumRelayMultiplexedFrameBytes) {
    throw new Error("Invalid relay multiplexed frame")
  }
  const id = new DataView(bytes.buffer, bytes.byteOffset, relayMultiplexHeaderBytes).getUint32(0, true)
  if (id === 0) throw new Error("Invalid relay multiplexed frame")
  // Uint8Array.from copies Node Buffer inputs too; Buffer.slice is only a view.
  return { channelId: id, frame: Uint8Array.from(bytes.subarray(relayMultiplexHeaderBytes)) }
}
