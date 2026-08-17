# Security policy

## Supported versions

Security fixes are released for the latest published version only.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's security advisory form](https://github.com/deitum/agent-engine/security/advisories/new)
rather than opening a public issue. We aim to acknowledge reports within a few working days.

## What this daemon can do to the machine it runs on

A great deal, by design. It exists to be the part of an agentic app that has a filesystem, can spawn
a process and sits inside the user's own network. Before pointing it at a machine that matters, four
things are worth understanding.

**It runs arbitrary commands.** The coding sandbox executes what the model asks for. Those commands
run inside a Docker container over a bind-mounted checkout — but `git` itself runs on the **host**,
and the container shares the host's dependency caches. A container is isolation, not a guarantee.

**It spawns stdio MCP servers.** Any `command` in an MCP config the client forwards is executed as a
child process, with the `env` the client supplied. The engine does not vet those commands; whatever
decides which servers a user may connect is the embedding app's job, not this one's.

**It writes to the user's home.** Everything lives under `~/.agent-engine` (`AGENT_ENGINE_HOME`
moves it): git checkouts, agent workspaces, package caches, and `state.db`. It also edits config
files belonging to _other_ tools on request — `~/.claude.json`, an OpenCode or Kilo config — leaving
the previous version beside the new one with an `.agent-engine.bak` suffix.

**`state.db` is a password file.** It is created `0600` and holds whatever the embedding app stores,
which in practice includes the model token, repository credentials and every MCP server's `env` and
`headers`. Treat a backup of it the way you would treat a keychain.

Tool results are untrusted input to whatever model consumes them: a web page, a repository file and
an MCP server's response may all say anything, including instructions aimed at the model.

## Credentials and transport

The daemon listens on **loopback only** (`127.0.0.1`) and every route but `GET /ping` requires
`Authorization: Bearer <token>`. `/ping` is deliberately unauthenticated so a client can tell "daemon
down" from "wrong token"; it reports the name, version, whether the token matched, and nothing else.

Configuration — the gateway URL, the model key, repository tokens — arrives once through
`POST /config` and is held **in memory for the life of the process**. Nothing from it is written to
disk and nothing is logged: a restarted daemon knows nothing until the client hands the bundle over
again.

Repository tokens never land in a checkout. Clone URLs are credential-free and git is authenticated
per invocation with `http.extraHeader`, so nothing survives in `.git/config`.

`caCerts` from the handshake and `NODE_EXTRA_CA_CERTS` both add trust anchors; neither disables
verification, and the engine has no option that does.
