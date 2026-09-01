import { useState, type FormEvent } from "react"

import type { DevicePairResult } from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "./components/ui/field"
import { Input } from "./components/ui/input"

export type PairMachineRequest = {
  endpoint: string
  code: string
  label: string
}

export function PairMachineDialog({
  open,
  onOpenChange,
  onClaim,
  onPaired,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onClaim: (request: PairMachineRequest) => Promise<DevicePairResult>
  onPaired: (paired: DevicePairResult) => void
}) {
  const [endpoint, setEndpoint] = useState("")
  const [code, setCode] = useState("")
  const [label, setLabel] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")

  const ready = endpoint.trim() && code.trim() && label.trim()

  const forget = () => {
    // The code is a live credential while it lasts, so nothing is kept once the
    // dialog closes.
    setEndpoint("")
    setCode("")
    setLabel("")
    setError("")
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || pending) return
    setPending(true)
    setError("")
    try {
      const paired = await onClaim({
        endpoint: endpoint.trim(),
        code: code.trim(),
        label: label.trim(),
      })
      onPaired(paired)
      forget()
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pairing was refused")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) forget()
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Pair a machine</DialogTitle>
            <DialogDescription>
              Run <span className="font-machine">domovoid pair</span> on the other machine and enter
              the code it shows. A code works once and lasts a few minutes.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert variant="destructive" aria-live="polite">
              <AlertTitle>Pairing failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="pair-endpoint">Machine address</FieldLabel>
              <Input
                id="pair-endpoint"
                value={endpoint}
                autoFocus
                disabled={pending}
                placeholder="wss://workshop.tailnet:47831/rpc"
                onChange={(event) => setEndpoint(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="pair-code">Pairing code</FieldLabel>
              <Input
                id="pair-code"
                value={code}
                disabled={pending}
                placeholder="hearth-quiet-ember-42"
                className="font-machine"
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="pair-label">Name for this device</FieldLabel>
              <Input
                id="pair-label"
                value={label}
                disabled={pending}
                placeholder="studio-ipad"
                onChange={(event) => setLabel(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || pending}>
              {pending ? "Pairing machine" : "Pair machine"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
