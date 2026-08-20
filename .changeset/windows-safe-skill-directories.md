---
'@deitum/agent-engine': patch
---

Materialize skills and project files into directory names Windows can create.

A skill id is used verbatim as a directory name under the deep-agent workspace, so an embedder that
namespaces a plugin's skill as `<plugin>:<skill>` produced `…\skills\aft-sa:jira-task-onboarding` —
and Windows reserves the colon for alternate data streams, so every turn using that skill died with
`ENOENT: no such file or directory, mkdir`. The same held for a project file or a skill's bundled
reference whose name carried a colon, a trailing dot, or a reserved device name (`aux.md`).

`safeRelPath` now sanitises each segment it keeps, and `materializeSkills` slugs the skill id with
the same `packageName` rules the local package writer already used, suffixing `-2`, `-3` when two
ids slug alike so the caller's namespacing still separates them. The Code session's skills go
through the same function and are fixed with it.
