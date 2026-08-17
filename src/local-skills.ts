import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ConnectorError } from './connector';
import {
  type LocalSkillDeleteRequest,
  type LocalSkillDeleteResponse,
  type LocalSkillWriteRequest,
  type LocalSkillWriteResponse,
  type Skill,
} from './contracts';
import { RM_RETRY } from './platform.constants';
import {
  expandHome,
  packageName,
  readSkillPackages,
  resolvePackageDir,
  SKILL_FILE,
  writeSkillPackage,
} from './skill-package';

export { expandHome } from './skill-package';

/**
 * Reads every Anthropic-style skill package in a directory on the user's
 * machine: each immediate sub-directory holding a `SKILL.md` is one skill, with
 * any other files bundled as resources. Mirrors the API's `skills.loader.ts`,
 * but a missing directory is an error here — the user typed the path, so they
 * should be told it isn't there.
 */
export function listLocalSkills(dir: string): { dir: string; skills: Skill[] } {
  const root = expandHome(dir);
  return { dir: root, skills: readSkillPackages(root) };
}

/**
 * Writes one skill into `<dir>/<id>/` as an Agent Skills package: a `SKILL.md`
 * carrying `name` / `description` / `manifest` frontmatter plus the instructions
 * body, and every bundled file at its relative path. The same layout the web
 * client produces for a `.zip` export, so a skill round-trips between the two.
 *
 * Existing files are overwritten in place; files already in the directory that
 * the skill no longer carries survive unless the request asks to `prune` them.
 */
export function writeLocalSkill(request: LocalSkillWriteRequest): LocalSkillWriteResponse {
  const root = expandHome(request.dir);
  const { skill } = request;
  const name = skill.name.trim();
  if (!name) {
    throw new ConnectorError(400, 'The skill has no name');
  }

  // The display name is the fallback when the id slugifies to nothing, so the
  // caller can send a raw id and still land in a sane directory.
  const base = resolvePackageDir(root, packageName(skill.id) ? skill.id : name);
  const overwritten = existsSync(base);

  const pruned = writeSkillPackage(base, skill, { prune: request.prune === true });

  return { path: base, overwritten, pruned };
}

/**
 * Removes one package from the folder — the catalogue's Delete for a local
 * skill. A directory without a `SKILL.md` is refused: the id travels from the
 * browser, and this is what keeps a stray value from wiping a folder that was
 * never a skill in the first place.
 */
export function deleteLocalSkill(request: LocalSkillDeleteRequest): LocalSkillDeleteResponse {
  const root = expandHome(request.dir);
  const base = resolvePackageDir(root, request.id);

  if (!existsSync(join(base, SKILL_FILE))) {
    throw new ConnectorError(404, `Skill package not found: ${base}`);
  }

  rmSync(base, RM_RETRY);

  return { path: base };
}
