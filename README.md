# @deitum/agent-engine

The engine an agentic app runs **on the user's own machine**.

One npx-runnable HTTP daemon that hosts the parts a browser cannot: stdio MCP servers, deep
agents, a Docker coding sandbox with language servers, on-disk Agent Skills and plugins, web
search, a SQLite database, and every call to the model. Your app keeps the UI, the conversation
and the product decisions; this keeps the process, the filesystem and the network.

```bash
npx @deitum/agent-engine
```

It prints a URL and a token. Hand both to your app, which then tells the daemon how to reach a
model (`POST /config`) and starts making calls.

```ts
import { EngineClient } from '@deitum/agent-engine/client';

const engine = new EngineClient({ port: 50880, token });

await engine.config({
  version: 'v1',
  llm: { baseUrl: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY! },
});

for await (const event of engine.deepAgent.stream(runRequest)) {
  render(event);
}
```

## Why a daemon

Three things an agent needs are exactly the three things a web page cannot have: a real
filesystem, the ability to spawn a process, and a network position inside the user's own
network. Putting them on a shared server solves none of that and creates a new problem — every
user's credentials and files now live somewhere they are not.

So the engine runs where the work is. The consequences are the point:

- **stdio MCP servers work.** They are subprocesses; there is a process here to be their parent.
- **On-prem hosts are reachable.** The daemon is already inside the network a corporate GitLab,
  Bitbucket or Jira sits in — no VPN gateway, no CORS.
- **Secrets stay put.** The model key, the repository tokens and every MCP server's `env` are
  held in memory for the life of the process and written nowhere.
- **The coding sandbox is real.** A git clone on disk, a Docker container over it, language
  servers inside it.

## Entry points

| Import                           | What it is                                 | Runs where            |
| -------------------------------- | ------------------------------------------ | --------------------- |
| `@deitum/agent-engine`           | The daemon, to build into your own process | Node ≥ 22             |
| `@deitum/agent-engine/client`    | A typed HTTP client for a running daemon   | Node **or** a browser |
| `@deitum/agent-engine/contracts` | The wire contract alone, no runtime        | Anywhere              |

The client and the daemon are built from the same contract, so a route's request and response
shapes cannot drift apart between the two sides.

### Embedding the daemon

`npx` is the ordinary way to start it. Embed it instead when your app owns the process — a
desktop shell that must stop the daemon when its window closes, for instance:

```ts
import { createEngineServer } from '@deitum/agent-engine';

const server = createEngineServer({ token, onShutdownRequest: () => stop() });
server.listen(50880, '127.0.0.1');

// Ends open streams, closes MCP connections, stops the sandbox containers.
await server.shutdownConnector();
```

## Configuration

The daemon learns everything it runs on **once**, when a client connects, rather than in the body
of every request. The split is configuration against content: an address, a credential or a
policy is the same for every turn and belongs in the handshake; what a run is _about_ stays in
the run request.

```http
POST /config
{
  "version": "sha-of-this-bundle",
  "llm": { "baseUrl": "https://gateway.example/v1", "apiKey": "sk-…" },
  "search": { "enabled": true },
  "repos": [{ "provider": "github", "token": "ghp_…" }]
}
```

Everything in it is held **in memory only**. Nothing is written to disk, the user's key least of
all — which also means a restarted daemon knows nothing. `GET /ping` reports the
`configVersion` it holds, so a client that sees a version other than its own hands the bundle
over again; one probe interval later the restart is invisible. The client in this package does
that for you through `onConfigMissing`.

### Letting a deployment own the gateway address

An app with a control plane usually wants the model endpoint to be an administrative setting
rather than a per-machine one. Name a URL instead of a `baseUrl` and the daemon fetches it:

```http
POST /config
{ "version": "…", "hostConfigUrl": "https://app.example/api/llm/config", "llm": { "apiKey": "sk-…" } }
```

That URL must answer with the whole of the contract this engine imposes on a host — one `GET`,
one JSON object:

```jsonc
{
  "baseUrl": "https://gateway.example/v1",
  // Optional: PEM blocks added to this process's trust store, so a corporate TLS
  // gateway works without the user setting NODE_EXTRA_CA_CERTS.
  "caCerts": ["-----BEGIN CERTIFICATE-----\n…"],
  // Optional, and a last resort: `false` stops this daemon verifying certificates
  // at all. See «Turning certificate verification off» below.
  "sslVerify": true,
}
```

No route naming, no authentication assumed: the client passes a complete URL, so the engine never
has to know how your host spells its own paths. `llm.baseUrl` wins when both are given.

### Turning certificate verification off

On a network that intercepts TLS with a certificate you cannot obtain, publishing `caCerts` is not
an option and every outbound call fails. `sslVerify: false` — in the handshake bundle
(`llm.sslVerify`), in the host config above, or as `AGENT_ENGINE_SSL_VERIFY=false` on the daemon's
own environment — stops this process verifying certificates **anywhere**: the gateway, repository
hosts, the catalogue, web search, remote MCP servers, and the `git`, stdio servers and containers
it spawns.

It is the last resort, not a setting: traffic can then be read and altered by anything on the
path. Either side may turn verification off and neither can turn it back on for the other, so a
user who started the daemon insecurely stays that way whatever the deployment says. `POST /config`
answers with the `sslVerify` actually in force, and the daemon warns once on the console.

Withdrawing the flag restores verification at the next handshake, for every host and every new
connection — but a keep-alive socket already open to a host this process accepted stays usable
until it goes idle. Restart the daemon if that matters.

## HTTP API

Everything but `GET /ping` takes `Authorization: Bearer <token>`. Streaming routes answer
`text/event-stream`, one JSON event per `data:` frame, ending with `data: [DONE]`.

| Route                                                                                             | Purpose                                                                     |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /ping`                                                                                       | Connectivity probe: name, version, `authorized`, `storage`, `configVersion` |
| `POST /config`                                                                                    | The handshake above                                                         |
| `POST /shutdown`                                                                                  | Stop the daemon, cleaning up containers                                     |
| `POST /mcp/tools`, `/mcp/tools/call`                                                              | List and invoke the tools of a forwarded MCP config                         |
| `POST /deepagent/stream`                                                                          | Run a deep agent (SSE)                                                      |
| `POST /deepagent/answer`, `/deepagent/client-tool`                                                | Unblock a tool waiting on the client                                        |
| `GET /tasks/list`, `/tasks/events` · `POST /tasks/message`, `/tasks/stop`                         | Background tasks                                                            |
| `POST /code/clone`, `/code/setup`, `/code/stream`, `/code/command`, `/code/remove`                | The coding sandbox                                                          |
| `GET /code/status`, `/code/diff`, `/code/sessions`, `/code/memory`, `/code/context`, `/code/spec` | Its state                                                                   |
| `POST /skills/list`, `/skills/write`, `/skills/delete`                                            | Agent Skills in a folder on disk                                            |
| `POST /skills/repo/list`, `/skills/repo/fetch`                                                    | Agent Skills in a git repository                                            |
| `POST /plugins/list`, `/plugins/write` · `POST /files/write`                                      | Claude Code plugins, loose files                                            |
| `POST /repos/check`                                                                               | Verify repository credentials against their host                            |
| `POST /llm/chat/completions`, `/llm/models`                                                       | The model, relayed frame for frame                                          |
| `GET /search/status` · `POST /search/start`, `/search/stop`                                       | The managed SearXNG instance                                                |
| `POST /storage/records/*`, `/storage/documents/*`                                                 | The client database (SQLite)                                                |

Request and response shapes are the exported contract, so
`import { type DeepAgentRunRequest } from '@deitum/agent-engine/contracts'` types both sides.

### What `/ping` reports

Not a feature list: every route this engine serves, it serves, so what a build can do is its
`version` — an embedder that needs a route added in some release compares against that.

`/ping` carries the two things that differ between two runs of the _same_ build. `authorized` says
whether the bearer token matched (the probe itself is unauthenticated on purpose, or a client could
not tell «daemon down» from «wrong token»). `storage` says whether this host's Node has
`node:sqlite` — without it the daemon runs normally and only `/storage/*` answers 501, so a client
that means to keep its database here should refuse up front rather than half-way through. And
`configVersion` is the handshake's version, or `''` when the daemon holds none.

## Repository providers

Two features spend repository credentials — the coding sandbox's clone / push / pull-request and
the skills catalogue's repository import — and both go through one provider layer.

| Provider                       | `provider`                   | Notes                                                              |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------------ |
| Bitbucket Server / Data Center | `bitbucket-server` (default) | On-prem; `baseUrl` required                                        |
| GitHub                         | `github`                     | Public instance by default; name a `baseUrl` for Enterprise Server |

A reference is `{ provider?, baseUrl?, owner, repo, ref?, path? }`. Credentials are matched by
provider, and by host when the user has more than one account on one provider. Only a token is
required — GitHub accepts a PAT against the conventional `x-access-token` user, and the engine
fills that in.

The token never lands in the checkout: clone URLs are credential-free and git is authenticated
per invocation with an `http.extraHeader`, so nothing survives in `.git/config`.

## What it keeps on disk

Everything under `~/.agent-engine` (override with `AGENT_ENGINE_HOME`):

```
~/.agent-engine/
  state.db          # the client database, when an app moves its storage here
  code/<session>/   # git checkouts for the coding sandbox
  deep-agents/      # per-chat agent workspaces, aged out at startup
  cache/            # package-manager caches shared by every session
```

`state.db` is created on first use with mode `0600` and holds whatever the app stores, tokens
included — treat it as a password file. It needs `node:sqlite` (Node 22.5+); on an older Node the
daemon runs normally and `GET /ping` reports `storage: false`, so an app can refuse to move its
data here rather than stranding it.

## Environment

| Variable                       | Default              | What it does                                                |
| ------------------------------ | -------------------- | ----------------------------------------------------------- |
| `PORT`                         | `50880`              | Port the daemon listens on (`127.0.0.1` only)               |
| `AGENT_ENGINE_TOKEN`           | generated            | Bearer token, when not passed as `argv[1]`                  |
| `AGENT_ENGINE_HOME`            | `~/.agent-engine`    | Root for everything written to disk                         |
| `AGENT_ENGINE_DEBUG_EVENTS`    | off                  | `1` echoes every stream event to the console                |
| `AGENT_ENGINE_DEBUG_TIMING`    | off                  | `1` prints one line per turn, and per gateway call          |
| `AGENT_ENGINE_LLM_MAX_RETRIES` | `3`                  | Retries per model call; `0` disables them                   |
| `AGENT_ENGINE_USER_AGENT`      | package name/version | `User-Agent` for gateway calls                              |
| `AGENT_ENGINE_DNS_SEARCH`      | detected             | DNS search domains for sandbox containers                   |
| `AGENT_ENGINE_SSL_VERIFY`      | `true`               | `false` stops verifying TLS certificates anywhere (above)   |
| `NODE_EXTRA_CA_CERTS`          | —                    | Extra CA, when neither the OS store nor `caCerts` covers it |

**User-Agent.** The daemon calls the gateway under its own name, replacing the `langchainjs-openai/…`
the OpenAI SDK would send. That is not cosmetic: gateways route on this header, and on one corporate
deployment every `User-Agent` containing «langchain» was answered in 61–84 seconds while the byte-identical
request under any other name came back in ~1.3 — one header, 40× the latency. Point
`AGENT_ENGINE_USER_AGENT` somewhere else if your gateway expects something specific.

**Retries.** A model call that fails is retried, and langchain's own default is six attempts with
an exponential backoff whose last one starts ~113 seconds after the first — silently, so a gateway
refusing the first few attempts is indistinguishable from a model thinking for two minutes. The
daemon bounds that at three and reports every rejected attempt: to the console, and to the run as
a non-fatal `error` event. Raise `AGENT_ENGINE_LLM_MAX_RETRIES` for a gateway that genuinely needs
more patience.

**TLS.** The daemon calls the model gateway itself, and on a corporate machine the CA that signs
it usually lives in the OS store — which Node ignores unless told. Three ways, in order of least
work: the host publishes its CA through `caCerts`; the CA is in the machine's own store, which
the daemon merges at startup; or `NODE_EXTRA_CA_CERTS`. The first two need Node ≥ 22.15
(`tls.setDefaultCACertificates`); on anything older the daemon says so once and only the third
works.

## Windows

Everything works natively — MCP (stdio included), skills, plugins, deep agents, web search and the
coding sandbox. Prerequisites: Node ≥ 22, [Git for Windows](https://git-scm.com/download/win), and
Docker Desktop with the WSL2 backend for the sandbox and search.

Environment variables are per-shell in PowerShell, not `VAR=value` prefixes:

```powershell
$env:PORT = "50880"
npx @deitum/agent-engine <token>
```

Folder paths accept either separator and `~` expands to the profile. Set `AGENT_ENGINE_HOME` if
that profile path holds non-ASCII characters, which Docker's file sharing has historically
mishandled. Known limitations: a bind-mounted Windows path into a Linux container is noticeably
slower than on macOS/Linux; a repository containing symlinks checks them out as text files unless
Developer Mode is on; the deep-agent sandbox shells out through `cmd.exe` rather than a POSIX
shell.

## License

MIT
