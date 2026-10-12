import { useEffect, useState } from "react"

import type { ClientKind, ProviderModel } from "@getdomovoi/protocol"

import { modelImages, type ModelImages } from "../attachments"
import type { DaemonCall, DaemonStatus } from "./daemon"

// Phone v2 frames 13, 13b and 14b: whether the open session's model takes
// image input, as its harness reports it through runtime.models. The phone
// asks once per provider on an open connection, and again after a reconnect,
// because a daemon update can change what a harness reports. An answer is
// dropped when its connection or provider ends.
//
// Undefined when no session is open. While the answer is outstanding, or when
// the daemon did not answer, image input is not known, which never locks
// anything: the daemon still refuses a send the model cannot take.
export function useModelImages(
  call: DaemonCall,
  status: DaemonStatus,
  client: ClientKind,
  runtime: { provider: string, model: string } | undefined,
): ModelImages | undefined {
  const [held, setHeld] = useState<{ provider: string, models: ProviderModel[] } | undefined>(undefined)
  const provider = runtime?.provider

  useEffect(() => {
    if (status !== "open" || provider === undefined) return
    // A new provider or a dropped connection ends this effect, so an answer
    // that arrives after either is not for what is open now.
    let live = true
    call("runtime.models", { provider, client }).then((models) => {
      if (live) setHeld({ provider, models })
    }, (cause: unknown) => {
      if (!live) return
      // An earlier answer for this provider may no longer be true.
      setHeld(undefined)
      console.warn("Models not read:", cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      live = false
      // An answer holds for the connection and provider it was asked on. A
      // reconnect or another provider asks again, and until that answer lands
      // nothing is known, which locks nothing (Codex review r1).
      setHeld(undefined)
    }
  }, [call, client, provider, status])

  if (!runtime) return undefined
  return modelImages(held?.provider === runtime.provider ? held.models : undefined, runtime)
}
