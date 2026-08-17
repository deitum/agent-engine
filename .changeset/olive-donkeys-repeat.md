---
'@deitum/agent-engine': patch
---

A timed-out or stopped sandbox command now returns as soon as it has been
killed.

`dockerExec` settled on the child's `close` event, which waits for every
inherited stdio pipe to close as well as for the process to exit — and a killed
`sh -c` leaves its own child holding one whenever the shell forks rather than
`exec`s. The result was a wait bounded by the command rather than by the
timeout: a one-second budget could return after thirty. After a deliberate kill
the outcome is already decided, so the exit alone is enough.
