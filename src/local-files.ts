import { join } from 'node:path';

import { ConnectorError } from './connector';
import { type LocalFilesWriteRequest, type LocalFilesWriteResponse } from './contracts';
import { expandHome, safeRelativePath, writeFileEnsured } from './skill-package';

/**
 * Drops a set of text files into a folder on the user's machine — the loose
 * halves of an integration bundle (an integration bundle): Kilo Code reads its slash
 * commands from `~/.config/kilo/commands/*.md` and Claude Code its commands and
 * sub-agents from `~/.claude/`, none of which is expressible in those tools'
 * config files. Skill *packages* keep going through `writeLocalSkill`, which
 * knows the Agent Skills layout.
 *
 * Every path is validated before anything is written, the same discipline
 * `writeLocalPlugin` follows: half a bundle on disk is worse than none, because
 * the config the user pastes would then promise files that are not there.
 */
export function writeLocalFiles(request: LocalFilesWriteRequest): LocalFilesWriteResponse {
  const root = expandHome(request.dir);
  const files = request.files ?? [];
  if (files.length === 0) {
    throw new ConnectorError(400, 'No files were given');
  }

  const planned = files.map((file) => ({
    path: safeRelativePath(file.path),
    content: file.content ?? '',
  }));

  for (const file of planned) {
    writeFileEnsured(join(root, ...file.path.split('/')), file.content);
  }

  return { dir: root, paths: planned.map((file) => file.path) };
}
