import { useEffect, useId, useRef, useState } from "react"
import type { ClientKind, FleetMachine } from "@getdomovoi/protocol"
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "./components/ui/field"
import { Input } from "./components/ui/input"
import { fleetAccessError } from "./fleet-access.js"

export function AuthorizeClientDialog({ machine, kind, onAuthorize, onClose }: {
  machine: FleetMachine; kind: ClientKind;
  onAuthorize: (machineId: string, credential: string, signal: AbortSignal) => Promise<void>;
  onClose: () => void
}) {
  const id = useId()
  const [credential, setCredential] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => { operation.current?.abort() }, [])
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Authorize this client for {machine.label}</DialogTitle>
        <DialogDescription>
          Machine pairing permits transfers. This separate credential allows session sends, approvals and terminals on {machine.label}.
          It cannot manage paired devices or enroll machines.
        </DialogDescription>
      </DialogHeader>
      <form className="flex min-w-0 flex-col gap-4" onSubmit={(event) => {
        event.preventDefault()
        if (operation.current || !credential.trim()) return
        const controller = new AbortController()
        operation.current = controller
        setPending(true)
        setError("")
        void onAuthorize(machine.id, credential.trim(), controller.signal).then(() => {
          if (!controller.signal.aborted) { setCredential(""); onClose() }
        }, (cause: unknown) => {
          if (!controller.signal.aborted) setError(fleetAccessError(cause).message)
        }).finally(() => {
          if (!controller.signal.aborted) { operation.current = null; setPending(false) }
        })
      }}>
        <p className="text-sm text-muted-foreground">Run this on {machine.label} using that daemon's own credential:</p>
        <code className="break-words font-machine text-sm">{`domovoid pair --client ${kind} --label "My ${kind}"`}</code>
        <FieldGroup>
          <Field data-invalid={Boolean(error)} data-disabled={pending}>
            <FieldLabel htmlFor={id}>Client credential</FieldLabel>
            <Input id={id} type="password" autoComplete="off" spellCheck={false} maxLength={43}
              value={credential} onChange={(event) => setCredential(event.target.value)} disabled={pending} aria-invalid={Boolean(error)} />
          </Field>
        </FieldGroup>
        <p className="text-sm text-muted-foreground">
          Kept only in this app's memory. Closing the app or removing local access does not revoke it.
          Revoke this device in {machine.label}'s Devices list to end its authority.
        </p>
        {error ? <Alert variant="destructive"><AlertTitle>Client access refused</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending || !credential.trim()}>{pending ? "Verifying identity and credential" : "Verify client access"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
