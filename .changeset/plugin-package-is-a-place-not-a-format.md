---
'@deitum/agent-engine': minor
---

Let a plugin stay a plugin in OpenCode and Kilo, instead of dissolving into loose skills.

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
