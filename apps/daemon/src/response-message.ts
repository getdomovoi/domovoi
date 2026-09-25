import {
  deviceLabelMismatchSchema,
  fleetSnapshotOverflowSchema,
  projectSwitchConfirmationSchema,
  protocolMismatchSchema,
  rpcMethods,
  rpcResponseSchema,
  sessionAttachmentRefusalSchema,
  skillInstallRefusalSchema,
  turnSkillSelectionRefusalSchema,
  type DeviceLabelMismatch,
  type FleetSnapshotOverflow,
  type ProjectSwitchConfirmation,
  type ProtocolMismatch,
  type RpcMethod,
  type RpcResponse,
  type SessionAttachmentRefusal,
  type SkillInstallRefusal,
  type TurnSkillSelectionRefusal,
} from "@getdomovoi/protocol"

import { isRecord, undeclaredFields } from "./undeclared-fields.js"

export type ResponseFrame = { readonly text: string, readonly response: RpcResponse }

export type RpcErrorData =
  | ProjectSwitchConfirmation
  | TurnSkillSelectionRefusal
  | FleetSnapshotOverflow
  | DeviceLabelMismatch
  | ProtocolMismatch
  | SkillInstallRefusal
  | SessionAttachmentRefusal

export type RpcErrorObject = { code: number, message: string, data?: RpcErrorData }

// The protocol declares no error data per method or per code. It declares these
// shapes, each named by its kind, and error data must be one of them.
const errorDataSchemas = {
  "project-switch-confirmation": projectSwitchConfirmationSchema,
  "turn-skill-selection-refused": turnSkillSelectionRefusalSchema,
  "fleet-overflow": fleetSnapshotOverflowSchema,
  "device-label-mismatch": deviceLabelMismatchSchema,
  "protocol-mismatch": protocolMismatchSchema,
  "skill-install-refused": skillInstallRefusalSchema,
  "session-attachment-refused": sessionAttachmentRefusalSchema,
} as const

const issuedFrames = new WeakSet<ResponseFrame>()

// True only for a frame responseMessage or errorResponseMessage built. The RPC
// writer sends no other response.
export function isResponseFrame(value: unknown): value is ResponseFrame {
  return typeof value === "object" && value !== null && issuedFrames.has(value as ResponseFrame)
}

// A result reaches the wire only as its method's protocol schema describes it.
// The method must be a primitive string naming an own entry of rpcMethods, for
// the reason notificationMessage gives.
export function responseMessage(method: RpcMethod, id: string | number, result: unknown): ResponseFrame {
  const methodValue: unknown = method
  if (typeof methodValue !== "string" || !Object.hasOwn(rpcMethods, methodValue)) {
    throw new TypeError("A response method must be a string naming a protocol method.")
  }
  if (typeof id !== "string" && typeof id !== "number") {
    throw new TypeError("A result response id must be a string or a number.")
  }
  const { text, response } = serializedResponse({ jsonrpc: "2.0", id, result }, id)
  if (!Object.hasOwn(response, "result") || Object.hasOwn(response, "error")) {
    throw new TypeError(`A ${method} response must carry a result and no error.`)
  }
  const sent = response.result
  refuseUndeclared(`${method} result`, sent, rpcMethods[method].result.parse(sent))
  return issued(text, response)
}

export function errorResponseMessage(id: string | number | null, error: RpcErrorObject): ResponseFrame {
  if (id !== null && typeof id !== "string" && typeof id !== "number") {
    throw new TypeError("An error response id must be a string, a number, or null.")
  }
  const { text, response } = serializedResponse({ jsonrpc: "2.0", id, error }, id)
  if (!Object.hasOwn(response, "error") || Object.hasOwn(response, "result")) {
    throw new TypeError("An error response must carry an error and no result.")
  }
  const sentError: unknown = response.error
  if (isRecord(sentError) && Object.hasOwn(sentError, "data")) {
    const data = sentError.data
    const kind = isRecord(data) ? data.kind : undefined
    if (typeof kind !== "string" || !Object.hasOwn(errorDataSchemas, kind)) {
      throw new TypeError("Error data must be a kind of error data the protocol declares.")
    }
    const schema = errorDataSchemas[kind as keyof typeof errorDataSchemas]
    refuseUndeclared(`${kind} error data`, data, schema.parse(data))
  }
  return issued(text, response)
}

// The envelope is serialized once and read back, and every check runs on what
// was read back: toJSON can make the text differ from the object passed in.
function serializedResponse(envelope: object, id: string | number | null): { text: string, response: RpcResponse } {
  const text: string | undefined = JSON.stringify(envelope)
  if (text === undefined) throw new TypeError("The response did not serialize.")
  const readBack: unknown = JSON.parse(text)
  const checked = rpcResponseSchema.safeParse(readBack)
  if (!checked.success) {
    const paths = checked.error.issues.map((issue) => issue.path.join(".") || "envelope")
    throw new TypeError(`The serialized response is not a JSON-RPC 2.0 response: ${paths.join(", ")}`)
  }
  if (!isRecord(readBack) || readBack.id !== id) {
    throw new TypeError("The serialized response id does not match the request id.")
  }
  return { text, response: readBack as RpcResponse }
}

function refuseUndeclared(subject: string, sent: unknown, parsed: unknown): void {
  const undeclared = undeclaredFields(sent, parsed, "")
  if (undeclared.length > 0) {
    throw new Error(`${subject} carries fields its protocol schema does not describe: ${undeclared.join(", ")}`)
  }
}

function issued(text: string, response: RpcResponse): ResponseFrame {
  const frame = Object.freeze({ text, response })
  issuedFrames.add(frame)
  return frame
}
