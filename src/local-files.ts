import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ConnectorError } from './connector';
import {
  type LocalFilesDeleteRequest,
  type LocalFilesDeleteResponse,
  type LocalFilesWriteRequest,
  type LocalFilesWriteResponse,
} from './contracts';
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

/**
 * Takes those same files back out, so uninstalling a bundle can be as exact as
 * installing it was.
 *
 * Paths go through `safeRelativePath` first and all of them before anything is
 * removed — a delete is not undoable, and a request that names one path outside
 * the folder should not have deleted the ones before it by the time that is
 * noticed. A file that is not there is skipped rather than refused: the caller
 * asked for it to be gone, and it is.
 *
 * Files only. Emptied folders are left behind, because this route has no way to
 * tell a folder it created from one the user keeps their own commands in.
 */
export function deleteLocalFiles(request: LocalFilesDeleteRequest): LocalFilesDeleteResponse {
  const root = expandHome(request.dir);
  const paths = request.paths ?? [];
  if (paths.length === 0) {
    throw new ConnectorError(400, 'No paths were given');
  }

  const planned = paths.map((path) => safeRelativePath(path));
  const removed: string[] = [];

  for (const path of planned) {
    const absolute = join(root, ...path.split('/'));
    if (!existsSync(absolute)) {
      continue;
    }
    if (statSync(absolute).isDirectory()) {
      throw new ConnectorError(400, `«${path}» is a folder, not a file`);
    }
    rmSync(absolute, { force: true });
    removed.push(path);
  }

  return { dir: root, removed };
}
