// A word that makes the next word a value (an authorization scheme or a
// sensitive flag) placed at the end of a value another rule hides or reads
// past, with a credential as the next word. Every rule reads the original
// words, so the credential is hidden wherever the word that names it sits.

export const hiddenTriggerCredential = "s3cr3t-value"

// Every authorization scheme, in other cases too, and a sensitive flag for
// every sensitive key part, with the other spellings a flag can take.
export const hiddenTriggerWords: readonly string[] = [
  "Bearer", "Basic", "Token", "Digest", "bearer", "TOKEN",
  "--apikey", "--api-key", "--access-key", "--private-key", "--session-key", "--token", "--password", "--passwd", "--secret",
  "--credential", "--cookie", "--authorization", "--auth", "--pat", "-token", "--client_secret", "--API-KEY",
]

const credential = hiddenTriggerCredential

// Each kind of value, as shell text and as the argument vector of the same
// words, with the word at its end.
export const hiddenTriggerPlacements: ReadonlyArray<readonly [string, (word: string) => { text: string; argv: string[] }]> = [
  ["a URL's path", (word) => ({ text: `curl 'https://host/ ${word}' ${credential}`, argv: ["curl", `https://host/ ${word}`, credential] })],
  ["a URL with no path", (word) => ({ text: `curl 'https://host ${word}' ${credential}`, argv: ["curl", `https://host ${word}`, credential] })],
  ["a URL's query", (word) => ({ text: `curl 'https://host/?q=1 ${word}' ${credential}`, argv: ["curl", `https://host/?q=1 ${word}`, credential] })],
  ["a URL taken as a flag's value", (word) => ({ text: `curl --token 'https://host/ ${word}' ${credential}`, argv: ["curl", "--token", `https://host/ ${word}`, credential] })],
  ["a header's value", (word) => ({ text: `curl -H 'X-Foo: ${word}' ${credential}`, argv: ["curl", "-H", `X-Foo: ${word}`, credential] })],
  ["a header's value with a blank after it", (word) => ({ text: `curl -H 'X-Foo: ${word} ' ${credential}`, argv: ["curl", "-H", `X-Foo: ${word} `, credential] })],
  ["a header taken as a flag's value", (word) => ({ text: `curl --token 'x -H X-Foo: ${word} ' ${credential}`, argv: ["curl", "--token", `x -H X-Foo: ${word} `, credential] })],
  ["a flag's value", (word) => ({ text: `curl --token 'x ${word}' ${credential}`, argv: ["curl", "--token", `x ${word}`, credential] })],
  ["a single-quoted string", (word) => ({ text: `curl 'x ${word}' ${credential}`, argv: ["curl", `x ${word}`, credential] })],
  ["a double-quoted string", (word) => ({ text: `curl "x ${word}" ${credential}`, argv: ["curl", `x ${word}`, credential] })],
  ["an assignment's value", (word) => ({ text: `A='x ${word}' ${credential}`, argv: [`A=x ${word}`, credential] })],
  ["a quoted JSON value", (word) => ({ text: `echo '{"password": "x ${word}' ${credential}`, argv: ["echo", `{"password": "x ${word}`, credential] })],
  ["a shell's script", (word) => ({ text: `sh -c 'curl ${word}' ${credential}`, argv: ["sh", "-c", `curl ${word}`, credential] })],
  ["a shell's script with options", (word) => ({ text: `bash -lc 'curl ${word}' ${credential}`, argv: ["bash", "-lc", `curl ${word}`, credential] })],
]
