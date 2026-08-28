import { useState, type FormEvent } from "react"
import { KeyRoundIcon } from "lucide-react"

import { Button } from "./components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "./components/ui/field"
import { Input } from "./components/ui/input"
import { DomovoiMark } from "./domovoi-mark"

export function DaemonCredentialPrompt({
  onSubmit,
}: {
  onSubmit: (credential: string) => void
}) {
  const [credential, setCredential] = useState("")

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = credential.trim()
    if (value) onSubmit(value)
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-9 items-center justify-center rounded-md bg-accent text-primary">
            <DomovoiMark reduced className="size-5" />
          </div>
          <CardTitle>Connect to this daemon</CardTitle>
          <CardDescription>
            Enter the credential owned by the machine running Domovoi.
          </CardDescription>
        </CardHeader>
        <form onSubmit={submit}>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="daemon-credential">Daemon credential</FieldLabel>
                <Input
                  id="daemon-credential"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                />
                <FieldDescription>
                  Read it from <code className="font-machine text-foreground">~/.domovoi/daemon.token</code> on
                  the execution machine. It is kept only for this browser session.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter className="mt-5 flex justify-end">
            <Button type="submit" disabled={!credential.trim()}>
              <KeyRoundIcon data-icon="inline-start" />
              Connect
            </Button>
          </CardFooter>
        </form>
      </Card>
    </main>
  )
}
