---
'@deitum/agent-engine': minor
---

Let a plain chat completion name its reasoning effort.

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
