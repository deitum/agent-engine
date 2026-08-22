---
'@deitum/agent-engine': patch
---

Fix the two install recipes that stopped any language server from starting.

The Code tab's LSP layer has been dead in every release that shipped it, and silently, because an
unavailable server is designed to cost nothing: the middleware returns the tool result untouched and
the session carries on. Both failures were in the recipe table, not in the protocol.

The jdtls command joined `mkdir -p /cache/lsp/jdtls` and the `{ curl || wget; }` downloader group
with a space and no separator, so every attempt died on `sh: 1: Syntax error: "}" unexpected` after
0.2 s — Java analysis never installed once. And the TypeScript recipe installed an unpinned
`typescript`, which npm now resolves to 7.x: the native port ships a platform binary and no
`lib/tsserver.js`, so `typescript-language-server` refused to initialize with «Could not find a valid
TypeScript installation». It is pinned to the major the server can drive until it learns to speak to
the new compiler.

The recipes are now checked by `sh -n` in the tests — a parse of every install, launch and probe
command, which is the only check a missing separator does not survive. Python's probe joins them: it
asks for pip as well as the interpreter, so a `gradle:` or `node:` image (python3, no pip) reports
«the image has python3 but no pip» instead of a failed install.
