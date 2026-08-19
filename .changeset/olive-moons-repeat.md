---
'@deitum/agent-engine': patch
---

Keep the original error attached when one is rethrown as a readable one.

Three places turn a caught error into a sentence a user can act on — a failed agent stream, a page
that would not open, an unreachable SearXNG — and each of them used to drop the error it was
describing. The message is still the point, but the thing that produced it is now the new error's
`cause`, so a stack, an `errno` or a nested provider payload survives to whoever is reading the
logs. Nothing about the messages themselves changed, and code that only reads `.message` sees the
same string as before.
