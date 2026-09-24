// Credential stores in the home directory. The Codex sandbox refuses reads of
// each location, and an approval card hides and hard-gates a path or command
// that names one, in the home directory or anywhere else.
export type CredentialStore = Readonly<{
  location: `~/${string}`
  // What marks the store on a card, when the location is a directory that
  // also holds ordinary files: projects keep their own .docker directory, and
  // session worktrees live under ~/.domovoi.
  cardName?: string
}>

export const credentialStores: readonly CredentialStore[] = [
  { location: "~/.ssh" },
  { location: "~/.aws" },
  { location: "~/.domovoi", cardName: ".domovoi/daemon.token" },
  { location: "~/.config/gh" },
  { location: "~/.kube" },
  { location: "~/.docker", cardName: ".docker/config.json" },
  { location: "~/.netrc" },
  { location: "~/.gnupg" },
  { location: "~/.azure" },
  { location: "~/.config/gcloud" },
  { location: "~/.git-credentials" },
  { location: "~/.config/git/credentials" },
  { location: "~/.npmrc" },
  { location: "~/.pypirc" },
  { location: "~/.password-store" },
  { location: "~/.terraform.d" },
  { location: "~/.vault-token" },
  { location: "~/.pgpass" },
  { location: "~/.my.cnf" },
  { location: "~/.cargo/credentials.toml" },
  { location: "~/.gem/credentials" },
  { location: "~/.config/op" },
  { location: "~/.local/share/keyrings" },
  { location: "~/Library/Keychains" },
  { location: "~/.codex/auth.json" },
  { location: "~/.claude/.credentials.json" },
]

// The home-relative path that marks each store, one entry per path component.
export const credentialStoreNames: readonly (readonly string[])[] = credentialStores.map(
  ({ location, cardName }) => (cardName ?? location.slice(2)).split("/"),
)
