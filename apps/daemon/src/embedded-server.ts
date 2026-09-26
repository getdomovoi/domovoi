import { randomBytes } from "node:crypto"

type EmbeddedServer = {
  url: string
  close(): void
}

type EmbeddedServerOptions<TConfig> = {
  hostname: string
  port: number
  timeout: number
  config: TConfig
}

type EmbeddedClientOptions = {
  baseUrl: string
  headers: Record<string, string>
}

export async function createAuthenticatedEmbeddedRuntime<TClient, TConfig>({
  passwordEnvironment,
  usernameEnvironment,
  username,
  environment = {},
  config,
  createPassword = () => randomBytes(32).toString("base64url"),
  startServer,
  createClient,
}: {
  passwordEnvironment: string
  usernameEnvironment: string
  username: string
  environment?: Readonly<Record<string, string>>
  config: TConfig
  createPassword?: () => string
  startServer: (options: EmbeddedServerOptions<TConfig>) => Promise<EmbeddedServer>
  createClient: (options: EmbeddedClientOptions) => TClient
}): Promise<{ client: TClient; server: EmbeddedServer }> {
  const password = createPassword()
  const childEnvironment: Record<string, string> = {
    ...environment,
    [passwordEnvironment]: password,
    [usernameEnvironment]: username,
  }
  const previous = new Map(Object.keys(childEnvironment).map((name) => [name, process.env[name]]))
  let pendingServer: Promise<EmbeddedServer>
  try {
    // Both provider SDKs copy process.env synchronously while startServer spawns its child.
    Object.assign(process.env, childEnvironment)
    pendingServer = startServer({
      hostname: "127.0.0.1",
      port: 0,
      timeout: 10_000,
      config,
    })
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }

  const server = await pendingServer
  try {
    const authorization = Buffer.from(`${username}:${password}`).toString("base64")
    const client = createClient({
      baseUrl: server.url,
      headers: { authorization: `Basic ${authorization}` },
    })
    return { client, server }
  } catch (error) {
    server.close()
    throw error
  }
}
