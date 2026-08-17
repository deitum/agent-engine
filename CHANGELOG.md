# @deitum/agent-engine

## 0.3.0

### Minor Changes

- a01bd67: First release from the package's own repository.

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

### Patch Changes

- eb78709: A timed-out or stopped sandbox command now returns as soon as it has been
  killed.

  `dockerExec` settled on the child's `close` event, which waits for every
  inherited stdio pipe to close as well as for the process to exit — and a killed
  `sh -c` leaves its own child holding one whenever the shell forks rather than
  `exec`s. The result was a wait bounded by the command rather than by the
  timeout: a one-second budget could return after thirty. After a deliberate kill
  the outcome is already decided, so the exit alone is enough.
