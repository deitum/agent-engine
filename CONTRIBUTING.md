# Contributing

Thanks for taking the time. Bug reports, hosts this does not fit yet, and routes that answer a real
need are all welcome.

## Getting set up

```bash
npm install
npm run verify
```

`verify` is exactly what CI runs: lint → format → types → tests → packaging checks. Node 22 or newer
(`.nvmrc` pins 22; CI also runs 24, and one job on Windows).

| Command                 | What it does                                                      |
| ----------------------- | ----------------------------------------------------------------- |
| `npm test`              | build, then `node:test` over `dist/` — no network, no Docker      |
| `npm run test:coverage` | the same with V8 coverage and source maps                         |
| `npm run build`         | `tsc --build` → `dist` (CommonJS, so `npx` can run `dist/cli.js`) |
| `npm run dev`           | the same in watch mode                                            |
| `npm run start`         | run the built daemon                                              |
| `npm run lint:fix`      | eslint --fix                                                      |
| `npm run format`        | prettier --write                                                  |
| `npm run check:package` | publint + are-the-types-wrong, over all three entry points        |

### Why the tests run from `dist/`

The daemon is CommonJS compiled under `NodeNext`, and it lazy-loads its ESM-first dependencies
(deepagents, langchain) with real dynamic `import()`. A runner that transforms TypeScript on the fly
rewrites exactly that, so the tests would not exercise what ships. Running `node:test` over the
emitted output does. `files` in `package.json` keeps the compiled tests out of the tarball.

One consequence worth knowing: a leaked handle fails the **file**, not the test, so a suite that
passes every assertion can still come back red. Look for a timer or socket that outlived its test.

## How the code is arranged

```
src/
  cli.ts               the bin — reads the port and token, starts the daemon
  index.ts             library entry point (`createEngineServer`)
  server.ts            the HTTP surface: every route, and the SSE plumbing
  connector.ts         the MCP connection pool
  deep-agent.ts        the agent, its tool gate and the delegation middleware
  client/              the browser-safe typed client (`./client`)
  contracts/           the wire contract alone, no runtime (`./contracts`)
  code/                the Docker coding sandbox
    lsp/               language servers inside it
    openspec/          the spec workflow
  config/              the `POST /config` handshake, held in memory only
  llm/                 gateway calls, retries, repetition and token streaming
  plan/                plan mode and its nudges
  search/              the managed SearXNG instance and `web_fetch`
  storage/             the SQLite file behind `POST /storage/*`
  tasks/               background tasks
  vcs/                 Bitbucket Server and GitHub providers
```

Tests sit next to what they test (`platform.ts` ↔ `platform.test.ts`).

## House rules

- **This package has no idea who embeds it.** English strings only, no assumption that a particular
  API exists, no path that only one VCS could satisfy. The one thing it asks of a host is a URL that
  answers `{ baseUrl, caCerts? }`.
- **Secrets stay in memory.** Everything from `POST /config` — the model key, repository tokens, MCP
  `env` — lives for the life of the process and is written nowhere.
- **Windows is a supported platform, not an afterthought.** Anything that touches paths, processes or
  the environment goes through a pure function in `platform.ts` that takes the platform as an
  argument, so the Windows branch is testable from macOS.
- **A rename that reaches the user's machine needs a migration.** Container names, on-disk markers and
  file suffixes outlive a release: leave the old name in a `LEGACY_*` constant and clean it up, or a
  reboot resurrects it. See `LEGACY_SEARXNG_CONTAINERS`, `LEGACY_CONTAINER_PREFIXES` and
  `LEGACY_BLOCK_MARKERS` for the shape.
- **Constants live in `*.constants.ts`**, types in `*.types.ts`, enums in `*.enums.ts`.

## Releasing

Changesets. Add one with your change:

```bash
npx changeset
```

Merging to `master` opens (or updates) a "Version Packages" PR; merging that publishes to npm with
provenance.
