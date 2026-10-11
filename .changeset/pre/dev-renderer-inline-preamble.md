---
"@getdomovoi/desktop": patch
---

Let the development renderer load under its own content security policy.

The renderer policy ends `script-src 'self'`, which blocks every inline script.
Vite serves the react-refresh preamble as an inline module script, so the
development page failed with "@vitejs/plugin-react can't detect preamble", left
`#root` empty, and showed the window's background colour and nothing else.

Before the document is asked for, the main process now reads the development
page, hashes the inline scripts it actually carries, and names those hashes in
`script-src`. There is no `'unsafe-inline'` and no pinned preamble text, so a
change to the plugin's preamble changes the hash rather than breaking the load.

The packaged application is unchanged. It serves its own HTML through the
`domovoi-app` protocol, that HTML carries no inline script, and the policy stays
`script-src 'self'` there.
