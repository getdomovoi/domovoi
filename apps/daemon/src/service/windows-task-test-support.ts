// Decode only the data expression emitted by the Windows registration builder.
export function windowsTaskData(script: string, property: string): string | undefined {
  const line = script.split("\n").find((line) => line.startsWith(`${property} = `))
  const encoded = / = \[System\.Text\.Encoding\]::UTF8\.GetString\(\[System\.Convert\]::FromBase64String\('([A-Za-z0-9+/=]*)'\)\)$/.exec(line ?? "")?.[1]
  return encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf8")
}
