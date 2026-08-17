---
'@deitum/agent-engine': minor
---

First release from the package's own repository.

Names that reach the user's machine no longer carry the application this was
extracted from. Each rename ships with a migration, because a container, an
on-disk marker or a backup file outlives a release:

- the managed SearXNG container is `agent-engine-searxng`, and one left under the
  previous name is removed on start — it runs with `--restart unless-stopped`, so
  otherwise it survives a reboot and holds port 50881 against its replacement;
- per-session sandbox containers are prefixed `agent-engine-code-`, and a session
  whose container was created by an earlier build is still reaped on `remove`;
- the generated blocks in a project's notes file are marked
  `<!-- agent-engine:failures -->` / `<!-- agent-engine:project -->`, and a block
  left under the old markers is stripped rather than left to accumulate beside
  the new one;
- a config file the engine rewrites on the user's behalf is backed up with an
  `.agent-engine.bak` suffix;
- the default sandbox commit identity is `Agent Engine <agent@agent-engine.local>`
  when the repository credentials name no author;
- `web_fetch` identifies itself with the package's own name and version.
