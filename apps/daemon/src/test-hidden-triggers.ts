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

// The protocol backstop reads each text as written and in other views too:
// after one layer of percent decoding, after backslash and \u escapes, and
// as its double-quoted strings alone. It reads a scheme's value after an
// opening quote. A trigger that reads as one only in such a view, or whose
// value opens with a quote, is still a trigger, and its credential is hidden.
export const viewCredential = "swordfish"

const percentOf = (character: string) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
const encodedAt = (text: string, index: number) => `${text.slice(0, index)}${percentOf(text[index]!)}${text.slice(index + 1)}`

// Each trigger with the separator before its value, spelled with one of its
// characters percent-encoded: every character of the first three, the first
// letter of the rest, and every separator. An underscore is encoded in lower
// case too, and a scheme's first letter as a \u escape.
const viewTriggers: ReadonlyArray<readonly [string, string, boolean]> = [
  ["Token", " ", true], ["--token", " ", true], ["api_key", "=", true],
  ["Bearer", " ", false], ["Basic", " ", false], ["Digest", " ", false], ["--api-key", " ", false], ["password", "=", false], ["X-Api-Token", ": ", false],
]
export const encodedTriggers: readonly string[] = viewTriggers.flatMap(([trigger, separator, everyCharacter]) => {
  const first = trigger.search(/[A-Za-z]/u)
  const positions = everyCharacter ? Array.from(trigger, (_, index) => index) : [first]
  return [
    ...positions.map((index) => `${encodedAt(trigger, index)}${separator}`),
    `${trigger}${Array.from(separator, percentOf).join("")}`,
    ...(trigger.includes("_") ? [`${trigger.replace("_", "%5f")}${separator}`] : []),
    ...(separator === " " && first === 0 ? [`\\u${trigger.charCodeAt(0).toString(16).padStart(4, "0")}${trigger.slice(1)}${separator}`] : []),
  ]
})

// Values the backstop reads after a trigger: an alphabetic word it can take
// for prose, alone and with a word after it, and each behind an opening
// double or single quote.
export const viewValues: readonly string[] = [
  viewCredential, `${viewCredential} tail`, `"${viewCredential}"`, `"${viewCredential} tail"`, `'${viewCredential} tail'`,
]

// Where a trigger and its value sit: in one argument (a URL's authority, a
// URL's query name, a quoted string) or as words of their own.
export const viewPlacements: ReadonlyArray<readonly [string, (content: string) => string[]]> = [
  ["a URL's authority", (content) => [`https://host ${content}`]],
  ["a URL's query name", (content) => [`https://host/?${content}=1`]],
  ["a quoted string", (content) => [`x ${content}`]],
  ["words of their own", (content) => content.split(" ")],
]

const plainWord = /^[A-Za-z0-9_@%+=:,./-]+$/u
const singleWord = (word: string) => (plainWord.test(word) ? word : `'${word.replace(/'/gu, "'\\''")}'`)
const doubleWord = (word: string) => (plainWord.test(word) ? word : `"${word.replace(/[\\"$`]/gu, "\\$&")}"`)

// Each argument spelled in single quotes and in double quotes.
export const viewSpellings: ReadonlyArray<readonly [string, (word: string) => string]> = [["single-quoted", singleWord], ["double-quoted", doubleWord]]

// Every encoded trigger and value in one placement, spelling and wrapper, as
// shell text and as the argument vector of the same words.
export const viewCases = (
  place: (content: string) => string[],
  spell: (word: string) => string,
  wrap: (text: string, argv: readonly string[]) => { text: string; argv: string[] },
): Array<{ text: string; argv: string[] }> => encodedTriggers.flatMap((trigger) => viewValues.map((value) => {
  const words = ["curl", ...place(`${trigger}${value}`)]
  return wrap(words.map(spell).join(" "), words)
}))

// The concrete texts a review found: a quote before a value in the same word,
// encoded scheme words, keys and separators, a JSON argv's strings, a \u
// escape, and an escaped blank after a sensitive header's name or flag.
export const viewTexts: readonly string[] = [
  `curl 'https://host Token "${viewCredential} tail"'`,
  `curl 'https://host Token "${viewCredential}"'`,
  `curl 'https://host/?Token "${viewCredential}"=1'`,
  `curl 'https://host %54oken ${viewCredential} tail'`,
  `curl 'https://host Token%20${viewCredential} tail'`,
  `curl 'https://host %54oken ${viewCredential}'`,
  `curl 'https://host --%74oken ${viewCredential}'`,
  `curl 'https://host --token%20${viewCredential}'`,
  `curl 'https://host api%5fkey=${viewCredential}'`,
  `curl %54oken ${viewCredential} tail`,
  `curl 'x%20Token ${viewCredential} tail'`,
  `curl %27Token ${viewCredential} tail%27`,
  `curl 'https://host Authorization%3A Bearer ${viewCredential}'`,
  `curl '["--token","${viewCredential}"]'`,
  `curl '"Token" "${viewCredential} tail"'`,
  `curl '\\u0054oken ${viewCredential} tail'`,
  `curl -H X-Api-Token:\\ --token\\ ${viewCredential}`,
]

// An escaped blank between a sensitive header's name or a sensitive key and
// its value, which the shell reads as one word.
export const escapedBlankTexts: readonly string[] = [
  ...["X-Api-Token", "X-Auth-Token", "Cookie", "X-Secret"].flatMap((name) => [":\\ ", ":\\ \\ "].flatMap((separator) => (
    [viewCredential, `--token\\ ${viewCredential}`, `${viewCredential}\\ tail`].map((value) => `curl -H ${name}${separator}${value}`)
  ))),
  `API_KEY=\\ ${viewCredential} run`,
  `curl --api-key=\\ ${viewCredential}`,
  `curl --token\\ ${viewCredential}`,
  `curl --password=\\ \\ ${viewCredential}\\ tail`,
  `curl -H Authorization:\\ Bearer\\ ${viewCredential}`,
]
