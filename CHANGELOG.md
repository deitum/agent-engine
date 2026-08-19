# @deitum/agent-engine

## 0.5.0

### Minor Changes

- 7eda356: Let a plain chat completion name its reasoning effort.
  
  `ChatCompletionRequest` gains `reasoning_effort` (`'low' | 'medium' | 'high'`), forwarded to the
  gateway verbatim by `POST /llm/chat/completions` and by the daemon's own calls. It is the setting
  an agent run already had as `DeepAgentModelParams.reasoningEffort`, now reachable on the one path
  where the daemon does the least: a host that drives its own tool loop and uses this route only to
  relay the model. Until now the level a user picked was simply dropped there.
  
  Both wires speak one vocabulary — the exported `ReasoningEffort` — so a host that offers the
  setting once can hand it to either. Omitted still means the provider's default, and a model that
  does not reason ignores it, so nothing changes for a caller that sends nothing. A rejected request
  now names the effort in its log line, since it is the field a strict gateway is most likely to have
  objected to and the only one the user chose themselves.

### Patch Changes

- 7772e50: Keep the original error attached when one is rethrown as a readable one.
  
  Three places turn a caught error into a sentence a user can act on — a failed agent stream, a page
  that would not open, an unreachable SearXNG — and each of them used to drop the error it was
  describing. The message is still the point, but the thing that produced it is now the new error's
  `cause`, so a stack, an `errno` or a nested provider payload survives to whoever is reading the
  logs. Nothing about the messages themselves changed, and code that only reads `.message` sees the
  same string as before.

## 0.4.0

### Minor Changes

- d63962b: Add a way to turn TLS certificate verification off, for a network that intercepts TLS with a
  certificate nobody can hand over.

  `sslVerify: false` — in the handshake bundle (`llm.sslVerify`), in the `hostConfigUrl` answer, or
  as `AGENT_ENGINE_SSL_VERIFY=false` on the daemon's environment — applies to every outbound call
  the daemon makes: the gateway, repository hosts, the catalogue, web search, remote MCP servers,
  and the `git`, stdio servers and containers it spawns. It is applied before the host config is
  fetched, so a deployment behind such a certificate can still deliver the flag that makes its own
  address readable.

  The last resort, not a setting: publishing the interception CA as `caCerts` keeps the connection
  authenticated and is unchanged. Either side may turn verification off and neither turns it back on
  for the other; `POST /config` now answers with the `sslVerify` in force, and the daemon warns once
  on the console.

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
