---
'@deitum/agent-engine': minor
---

Add a way to turn TLS certificate verification off, for a network that intercepts TLS with a
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
