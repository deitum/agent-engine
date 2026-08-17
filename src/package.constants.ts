import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * This package's own name and version, read from its manifest.
 *
 * Both are reported by `GET /ping`, announced to every MCP server the daemon
 * connects to, and printed by the CLI — so a hard-coded copy is a copy that goes
 * stale at the first release and misreports the engine to everything downstream.
 * Read once, synchronously, at module load: it is two fields out of a file that
 * sits next to the code, and every caller wants them before it does anything.
 *
 * `dist/` is one level below the manifest; a failure to read it is not worth
 * crashing a daemon over, so the fallback is honest rather than fatal.
 */
function readManifest(): { name: string; version: string } {
  try {
    const raw = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');
    const manifest = JSON.parse(raw) as { name?: string; version?: string };
    return { name: manifest.name ?? 'agent-engine', version: manifest.version ?? '0.0.0' };
  } catch {
    return { name: 'agent-engine', version: '0.0.0' };
  }
}

const manifest = readManifest();

export const PACKAGE_NAME = manifest.name;
export const PACKAGE_VERSION = manifest.version;
