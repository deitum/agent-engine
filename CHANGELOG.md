# @deitum/agent-engine

## 0.6.0

### Minor Changes

- e4728f8: Let a plugin stay a plugin in OpenCode and Kilo, instead of dissolving into loose skills.
  
  `pluginsDir` was `null` for both, on the reading that neither has an Agent Plugins format — true,
  but it made the folder the wrong question. An embedder had nowhere to put the package, so it took
  the bundle apart on the way in: the skills were copied out into `skillsDir`, the commands and
  sub-agents became config keys, and `plugin.json`, the version and the `mcp.json` servers were
  dropped on the floor. What arrived was some skills, not a plugin — nothing to list, nothing to
  update, nothing to remove in one go.
  
  Both now name a folder (`<config dir>/plugins`, and `.opencode/plugins` / `.kilo/plugins` in a
  project), because OpenCode's own plugin loader globs `{plugin,plugins}/*.{ts,js}` one level deep —
  a package directory sitting beside those files is invisible to it. What makes the package legible
  is `skills.paths`, which names arbitrary skill folders and takes an absolute path; OpenCode has had
  that key for some time, so `declaresSkillPaths` is now true for it as well as for Kilo.
  
  Since a folder no longer implies discovery, `IntegrationTarget` gains **`readsPluginPackages`** —
  true only for Claude Code, the one target that opens a package and finds the manifest, the skills,
  the commands and the servers inside it by itself. Where it is false the folder is storage and the
  config document names the parts. `pluginsDir` is documented as what it now is: a place, not a
  format. `null` means this location has nowhere to put a package — which is still the case for
  Claude Code's project scope, where plugins are installed per user rather than per checkout.
  
  `POST /files/delete` joins `/files/write`, so the half of an install that is loose markdown can be
  taken back out. Without it, removing a bundle from a target that reads its commands as files left
  the markdown behind with no config key to clear — it outlived the thing that put it there. Paths
  are validated the same way a write's are, all of them before anything is removed; a path that is
  already gone is not an error, and a folder is refused.
- 1dbe0ba: Say which version started, that the user is done with the terminal, and where the log is.
  
  The startup banner is the daemon's whole user interface, and it was missing the three things the
  person who ran the command actually needs. It now names the build it is — `@deitum/agent-engine
  v<version> is running.` — so a support question about behaviour can be answered with the build that
  produced it rather than with «whatever npx resolved that day» — and it ends with
  `The connector is running — go back to the
  app.`, because the terminal is a step in the app's setup flow and nothing in it said that step was
  over.
  
  The third is new rather than reworded: the daemon now mirrors everything it prints into
  `~/.agent-engine/logs/engine.log`, one timestamp per line, rotating to `engine.log.1` at 5 MB, and
  names that path in the banner. Until now the only copy of a failed model call was the scrollback of
  a window the user had every reason to close. A home that cannot be written to costs the log file and
  nothing else — the daemon starts, warns once, and says so where the path would have been.

### Patch Changes

- bca5898: Fix the two install recipes that stopped any language server from starting.
  
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

## 0.5.1

### Patch Changes

- b2242c1: Materialize skills and project files into directory names Windows can create.
  
  A skill id is used verbatim as a directory name under the deep-agent workspace, so an embedder that
  namespaces a plugin's skill as `<plugin>:<skill>` produced `…\skills\aft-sa:jira-task-onboarding` —
  and Windows reserves the colon for alternate data streams, so every turn using that skill died with
  `ENOENT: no such file or directory, mkdir`. The same held for a project file or a skill's bundled
  reference whose name carried a colon, a trailing dot, or a reserved device name (`aux.md`).
  
  `safeRelPath` now sanitises each segment it keeps, and `materializeSkills` slugs the skill id with
  the same `packageName` rules the local package writer already used, suffixing `-2`, `-3` when two
  ids slug alike so the caller's namespacing still separates them. The Code session's skills go
  through the same function and are fixed with it.

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
