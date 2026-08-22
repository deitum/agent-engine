---
'@deitum/agent-engine': minor
---

Say which version started, that the user is done with the terminal, and where the log is.

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
