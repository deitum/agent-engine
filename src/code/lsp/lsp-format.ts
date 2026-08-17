import {
  MAX_CONTEXT_LINE_CHARS,
  MAX_NAVIGATION_RESULTS,
  MAX_TOOL_RESULT_CHARS,
} from './lsp.constants';
import {
  type LspDocumentSymbol,
  type LspHover,
  type LspLocation,
  type LspLocationLink,
  type LspMarkupContent,
  type LspPosition,
  type LspSymbolInformation,
  LSP_SYMBOL_KIND,
} from './lsp.types';
import { describeUri, fromContainerUri } from './paths';

/**
 * Turning a language server's answers into the few lines a model reads.
 *
 * Two jobs, both thankless and both worth isolating. The first is normalising:
 * every request in the protocol has two or three historical response shapes, and
 * servers in the wild use all of them. The second is fitting the answer into a
 * budget — a `find_references` on a popular interface can return four hundred
 * locations, and pasting them into the conversation costs the same window the
 * agent needs for the actual work.
 */

/** Reads the source lines of a checkout-relative path, or `null`. */
export type LineReader = (relative: string) => string[] | null;

/**
 * Normalises whatever `definition` / `references` / `implementation` returned
 * into a flat list of locations. The protocol allows a single `Location`, an
 * array of them, or an array of `LocationLink`s — for the last we take
 * `targetSelectionRange`, the identifier itself, rather than `targetRange`, which
 * spans the whole declaration including its doc comment.
 */
export function toLocations(result: unknown): LspLocation[] {
  if (!result) {
    return [];
  }
  const entries = Array.isArray(result) ? result : [result];
  const locations: LspLocation[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const link = entry as LspLocationLink;
    if (typeof link.targetUri === 'string') {
      locations.push({ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange });
      continue;
    }
    const location = entry as LspLocation;
    if (typeof location.uri === 'string' && location.range) {
      locations.push(location);
    }
  }
  return locations;
}

/** One line of source, trimmed and capped, for context next to a location. */
function contextLine(read: LineReader, uri: string, position: LspPosition): string {
  const relative = fromContainerUri(uri);
  if (!relative) {
    return '';
  }
  const line = read(relative)?.[position.line];
  if (line === undefined) {
    return '';
  }
  const trimmed = line.trim();
  return trimmed.length > MAX_CONTEXT_LINE_CHARS
    ? `${trimmed.slice(0, MAX_CONTEXT_LINE_CHARS - 1)}…`
    : trimmed;
}

/**
 * Renders locations as `path:line  source`, deduplicated and capped.
 *
 * Deduplication matters more than it looks: a server asked for references to an
 * overridden method reports the declaration once per subclass that inherits it,
 * and the same `path:line` can come back a dozen times.
 */
export function formatLocations(locations: LspLocation[], read: LineReader): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  let truncated = 0;

  for (const location of locations) {
    const label = `${describeUri(location.uri)}:${location.range.start.line + 1}`;
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    if (lines.length >= MAX_NAVIGATION_RESULTS) {
      truncated += 1;
      continue;
    }
    const context = contextLine(read, location.uri, location.range.start);
    lines.push(context ? `${label}  ${context}` : label);
  }

  const header = `Found: ${seen.size}`;
  const body = capLines(lines);
  return truncated > 0 ? `${header}\n${body}\n…and ${truncated} more.` : `${header}\n${body}`;
}

/** Keeps a rendered list inside {@link MAX_TOOL_RESULT_CHARS}. */
function capLines(lines: string[]): string {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > MAX_TOOL_RESULT_CHARS) {
      kept.push(`…(truncated, showing ${kept.length} of ${lines.length})`);
      break;
    }
    kept.push(line);
    size += line.length + 1;
  }
  return kept.join('\n');
}

/** A symbol flattened out of either response shape. */
export interface FlatSymbol {
  name: string;
  kind: string;
  /** Zero-based, as it came off the wire. */
  line: number;
  /** Enclosing class / module, when the server says. */
  container?: string;
  /** Only set for `workspace/symbol`, whose results span files. */
  uri?: string;
  /** Position of the name itself, for turning a symbol into a request. */
  position: LspPosition;
}

/**
 * Flattens `documentSymbol` (a tree of {@link LspDocumentSymbol}) or
 * `workspace/symbol` (a flat list of {@link LspSymbolInformation}) into one
 * shape. Both come back from requests we make, and older servers answer the
 * document request with the flat form too.
 */
export function flattenSymbols(result: unknown, container?: string): FlatSymbol[] {
  if (!Array.isArray(result)) {
    return [];
  }
  const flat: FlatSymbol[] = [];
  for (const entry of result) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const tree = entry as LspDocumentSymbol;
    if (tree.selectionRange && tree.range) {
      flat.push({
        name: tree.name,
        kind: LSP_SYMBOL_KIND[tree.kind] ?? 'symbol',
        line: tree.selectionRange.start.line,
        position: tree.selectionRange.start,
        ...(container ? { container } : {}),
      });
      if (Array.isArray(tree.children)) {
        flat.push(...flattenSymbols(tree.children, tree.name));
      }
      continue;
    }
    const flatEntry = entry as LspSymbolInformation;
    if (flatEntry.location?.range) {
      flat.push({
        name: flatEntry.name,
        kind: LSP_SYMBOL_KIND[flatEntry.kind] ?? 'symbol',
        line: flatEntry.location.range.start.line,
        position: flatEntry.location.range.start,
        uri: flatEntry.location.uri,
        ...(flatEntry.containerName ? { container: flatEntry.containerName } : {}),
      });
    }
  }
  return flat;
}

/** Renders symbols as an outline the model can navigate from. */
export function formatSymbols(symbols: FlatSymbol[], options: { withPath?: boolean } = {}): string {
  if (symbols.length === 0) {
    return 'Nothing was found.';
  }
  const lines = symbols.slice(0, MAX_NAVIGATION_RESULTS).map((symbol) => {
    // A workspace-wide result needs the file; a single file's outline does not,
    // and repeating its path on every line would be pure noise.
    const where = options.withPath && symbol.uri ? `${describeUri(symbol.uri)}:` : 'L';
    const qualified = symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
    return `${where}${symbol.line + 1}  ${symbol.kind} ${qualified}`;
  });
  const tail =
    symbols.length > MAX_NAVIGATION_RESULTS
      ? `\n…and ${symbols.length - MAX_NAVIGATION_RESULTS} more.`
      : '';
  return `Found: ${symbols.length}\n${capLines(lines)}${tail}`;
}

/**
 * Flattens a hover into plain text. `contents` has four historical shapes — a
 * string, a `{language, value}` pair, an array of either, and
 * {@link LspMarkupContent} — and servers still use all of them.
 */
export function hoverText(hover: LspHover | null | undefined): string {
  if (!hover) {
    return '';
  }
  return flattenHoverContent(hover.contents).trim();
}

function flattenHoverContent(contents: unknown): string {
  if (typeof contents === 'string') {
    return contents;
  }
  if (Array.isArray(contents)) {
    return contents.map(flattenHoverContent).filter(Boolean).join('\n');
  }
  if (contents && typeof contents === 'object') {
    const markup = contents as LspMarkupContent & { language?: string };
    if (typeof markup.value === 'string') {
      return markup.value;
    }
  }
  return '';
}
