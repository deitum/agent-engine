import { parse } from 'yaml';

/** Splits a package markdown file into its YAML frontmatter and the body. */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) {
    return { frontmatter: null, body: text };
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) {
    return { frontmatter: null, body: text };
  }
  const frontmatter = text.slice(3, end).replace(/^\r?\n/, '');
  const body = text.slice(end + 4).replace(/^[^\n]*\r?\n?/, '');
  return { frontmatter, body };
}

/**
 * Parses a frontmatter block into a plain object: strict YAML first, then a
 * lenient line scan if that throws.
 *
 * Skill and plugin packages in the wild routinely carry a one-line
 * `description:` with an unquoted `: ` inside it («the entry router: it routes
 * …»), which YAML reads as a nested mapping and rejects. Claude Code loads those
 * packages, so refusing them here would make a perfectly usable folder look
 * broken. Anything structured (a `manifest:` block) only ever comes from files
 * this daemon writes, which are valid YAML and never reach the fallback.
 */
export function parseFrontmatter(frontmatter: string | null): Record<string, unknown> {
  if (!frontmatter) {
    return {};
  }
  try {
    const parsed: unknown = parse(frontmatter);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Falls through to the lenient scan below.
  }
  return scanFlatFrontmatter(frontmatter);
}

/**
 * Reads `key: value` lines, treating everything after the first colon as a raw
 * string. An indented continuation line extends the previous value, and `- item`
 * lines collect into a list.
 */
function scanFlatFrontmatter(frontmatter: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let key: string | null = null;

  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) {
      continue;
    }

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && key) {
      const current = result[key];
      const list = Array.isArray(current) ? current : [];
      list.push(unquote(item[1]));
      result[key] = list;
      continue;
    }

    const entry = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (entry) {
      key = entry[1];
      const value = entry[2].trim();
      result[key] = value ? unquote(value) : '';
      continue;
    }

    if (key && typeof result[key] === 'string' && /^\s/.test(line)) {
      result[key] = `${result[key] as string} ${line.trim()}`.trim();
    }
  }

  return result;
}

/** Strips one layer of surrounding quotes from a scanned scalar. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^(".*"|'.*')$/s.test(trimmed)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** A frontmatter list accepted as a YAML list or a comma-separated string. */
export function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    // `[Read, Grep]` survives the lenient scan above as a raw string.
    return value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  return [];
}

/**
 * A frontmatter `argument-hint`. Real packages write it unquoted —
 * `argument-hint: [METHOD /endpoint, what to check]` — which YAML reads as a
 * flow sequence rather than the string the hint plainly is, so a list is put
 * back together instead of being dropped.
 */
export function parseHint(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string');
    return items.length > 0 ? `[${items.join(', ')}]` : '';
  }
  return '';
}
