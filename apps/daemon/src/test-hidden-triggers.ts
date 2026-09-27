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

// The same words with the credential in their own shell word, which a rule
// may have taken whole without hiding it: a URL whose authority or query name
// holds it, a quoted string, a header's value. The credential is an
// alphabetic word, which the protocol backstop can take for prose after a
// scheme, and a word it refuses, each alone and with a word after it.
export const sameWordCredentials: readonly string[] = ["swordfish", "s3cr3t-value"]

// Every word above, and the other rules whose value can follow them: a
// sensitive key joined by `=` or `:`, a header flag and name, a private key's
// header.
export const sameWordTriggers: readonly string[] = [
  ...hiddenTriggerWords, "password=", "api_key:", "-H X-Foo:", "--header X-Foo:", "-----BEGIN PRIVATE KEY-----",
]

// The text a trigger and its credential make in one word.
export const sameWordValues = (trigger: string): string[] => sameWordCredentials.flatMap((secret) => [`${trigger} ${secret}`, `${trigger} ${secret} tail`])

// Each place one shell word can hold that text, as shell text and as the
// argument vector of the same words.
export const sameWordPlacements: ReadonlyArray<readonly [string, (value: string) => { text: string; argv: string[] }]> = [
  ["a URL with no path", (value) => ({ text: `curl 'https://host ${value}'`, argv: ["curl", `https://host ${value}`] })],
  ["a URL's host after user info", (value) => ({ text: `curl 'https://user@host ${value}'`, argv: ["curl", `https://user@host ${value}`] })],
  ["a URL's query name", (value) => ({ text: `curl 'https://host/?${value}=1'`, argv: ["curl", `https://host/?${value}=1`] })],
  ["a URL's fragment name", (value) => ({ text: `curl 'https://host/#${value}=1'`, argv: ["curl", `https://host/#${value}=1`] })],
  // An unquoted `&` after a URL is read into it.
  ["a URL's query name read in through an operator", (value) => ({ text: `curl https://host/?q=1&'${value}=1'`, argv: ["curl", `https://host/?q=1&${value}=1`] })],
  ["a single-quoted string", (value) => ({ text: `curl 'x ${value}'`, argv: ["curl", `x ${value}`] })],
  ["a double-quoted string", (value) => ({ text: `curl "x ${value}"`, argv: ["curl", `x ${value}`] })],
  ["a header's value", (value) => ({ text: `curl -H 'X-Foo: ${value}'`, argv: ["curl", "-H", `X-Foo: ${value}`] })],
  ["a header's value after a scheme word", (value) => ({ text: `curl -H 'X-Foo: Bearer ${value}'`, argv: ["curl", "-H", `X-Foo: Bearer ${value}`] })],
  ["a sensitive header's value", (value) => ({ text: `curl -H 'X-Api-Token: ${value}'`, argv: ["curl", "-H", `X-Api-Token: ${value}`] })],
]

const singleQuoted = (text: string) => `'${text.replace(/'/gu, "'\\''")}'`
const doubleQuoted = (text: string) => `"${text.replace(/[\\"$`]/gu, "\\$&")}"`

// Each way a hook can hand the words to a shell: as they are, as a shell's
// script, and behind env, nested in another shell's script too.
export const sameWordWrappers: ReadonlyArray<readonly [string, (text: string, argv: readonly string[]) => { text: string; argv: string[] }]> = [
  ["as written", (text, argv) => ({ text, argv: [...argv] })],
  ["in sh -c", (text) => ({ text: `sh -c ${singleQuoted(text)}`, argv: ["sh", "-c", text] })],
  ["in bash -lc", (text) => ({ text: `bash -lc ${doubleQuoted(text)}`, argv: ["bash", "-lc", text] })],
  ["in env MODE=x sh -c", (text) => ({ text: `env MODE=x sh -c ${singleQuoted(text)}`, argv: ["env", "MODE=x", "sh", "-c", text] })],
  [
    "in sh -c in env -i bash -lc",
    (text) => ({ text: `env -i bash -lc ${doubleQuoted(`sh -c ${singleQuoted(text)}`)}`, argv: ["env", "-i", "bash", "-lc", `sh -c ${singleQuoted(text)}`] }),
  ],
]

// Every trigger's values in one placement and wrapper.
export const sameWordCases = (
  place: (value: string) => { text: string; argv: string[] },
  wrap: (text: string, argv: readonly string[]) => { text: string; argv: string[] },
): Array<{ text: string; argv: string[] }> => sameWordTriggers.flatMap((trigger) => sameWordValues(trigger).map((value) => {
  const { text, argv } = place(value)
  return wrap(text, argv)
}))
